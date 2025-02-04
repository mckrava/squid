import {DatabaseType} from "typeorm/driver/types/DatabaseType";
import {createOrmConfig} from "@subsquid/typeorm-config"
import {assertNotNull} from "@subsquid/util-internal"
import assert from "assert"
import 'dotenv/config'
import {DataSource, EntityManager} from "typeorm"
import {Store} from "./store"
import {createTransaction, Tx} from "./tx"


export type IsolationLevel = 'SERIALIZABLE' | 'READ COMMITTED' | 'REPEATABLE READ'


export interface TypeormDatabaseOptions {
    stateSchema?: string
    stateTable?: string
    isolationLevel?: IsolationLevel
    rdbmsType: DatabaseType
}


class BaseDatabase<S> {
    protected statusSchema: string
    protected statusTableFullPath: string
    protected isolationLevel: IsolationLevel
    protected con?: DataSource
    protected lastCommitted = -1
    protected rdbmsType = 'postgres'

    constructor(options?: TypeormDatabaseOptions) {
        this.statusSchema = options?.stateSchema ? `"${options.stateSchema}"` : 'squid_processor'
        this.statusTableFullPath = options?.rdbmsType === 'better-sqlite3'
            ? options?.stateTable || '__squid_processor_state_status'
            : `${this.statusSchema}.${options?.stateTable || 'status'}`
        this.isolationLevel = options?.isolationLevel || 'SERIALIZABLE'
        this.rdbmsType = options?.rdbmsType || process.env.RDBMS_TYPE || 'postgres'
    }

    async connect(): Promise<number> {
        if (this.con != null) {
            throw new Error('Already connected')
        }
        let cfg = createOrmConfig({rdbmsType: this.rdbmsType as DatabaseType})
        let con = new DataSource(cfg)
        await con.initialize()
        this.con = con

        try {
            let height = await con.transaction('SERIALIZABLE', async em => {
                if (this.rdbmsType !== 'better-sqlite3')
                    await em.query(`CREATE SCHEMA IF NOT EXISTS ${this.statusSchema}`)

                await em.query(`
                    CREATE TABLE IF NOT EXISTS ${this.statusTableFullPath} (
                        id int primary key,
                        height int not null
                    )
                `)

                let status: {height: number}[] = await em.query(
                    `SELECT height FROM ${this.statusTableFullPath} WHERE id = 0`
                )

                if (status.length == 0) {
                    await em.query(`INSERT INTO ${this.statusTableFullPath} (id, height) VALUES (0, -1)`)
                    return -1
                } else {
                    return status[0].height
                }
            })
            return height
        } catch(e: any) {
            await con.destroy().catch(() => {}) // ignore error
            throw e
        }
    }

    async close(): Promise<void> {
        let con = this.con
        this.con = undefined
        this.lastCommitted = -1
        if (con) {
            await con.destroy()
        }
    }

    async transact(from: number, to: number, cb: (store: S) => Promise<void>): Promise<void> {
        let retries = 3
        while (true) {
            try {
                return await this.runTransaction(from, to, cb)
            } catch(e: any) {
                if (e.code == '40001' && retries) {
                    retries -= 1
                } else {
                    throw e
                }
            }
        }
    }

    protected async runTransaction(from: number, to: number, cb: (store: S) => Promise<void>): Promise<void> {
        throw new Error('Not implemented')
    }

    protected async updateHeight(em: EntityManager, from: number, to: number): Promise<void> {
        let queryResult: [data: any[], rowsChanged: number] | number = this.rdbmsType === 'better-sqlite3' ?
            await em.query(
            `UPDATE ${this.statusTableFullPath} SET height = ? WHERE id = 0 AND height < ?`,
            [to, from]
        ) : await em.query(
            `UPDATE ${this.statusTableFullPath} SET height = $2 WHERE id = 0 AND height < $1`,
            [from, to]
        )

        /**
         * If (this.rdbmsType === 'better-sqlite3') => result: number
         */
        let rowsChanged = Array.isArray(queryResult) ? queryResult[1] : queryResult

        /**
         * Check by updated rows doesn't work for better-sqlite3 RDBMS as we are writing content and status data to the
         * same DB (the same connection instance)
         */
        if (this.rdbmsType === 'better-sqlite3') return;

        /**
         * Issue with SQLIte3 - result doesn't contain real count of updated rows -
         * https://github.com/typeorm/typeorm/issues/2660
         * so check below doesn't work for all cases:
         *
         *   assert.strictEqual(
         *       rowsChanged,
         *       1,
         *       'status table was updated by foreign process, make sure no other processor is running'
         *   )
         */
        assert.equal(
            (rowsChanged <= 1),
            true,
            'status table was updated by foreign process, make sure no other processor is running'
        )
    }
}


/**
 * Provides restrictive and lazy version of TypeORM EntityManager
 * to data handlers.
 *
 * Lazy here means that no database transaction is opened until an
 * actual database operation is requested by some data handler,
 * which allows more efficient data filtering within handlers.
 *
 * `TypeormDatabase` supports only primitive DML operations
 * without cascades, relations and other ORM goodies in return
 * for performance and exciting new features yet to be implemented :).
 *
 * Instances of this class should be considered to be completely opaque.
 */
export class TypeormDatabase extends BaseDatabase<Store> {
    protected async runTransaction(from: number, to: number, cb: (store: Store) => Promise<void>): Promise<void> {
        let tx: Promise<Tx> | undefined
        let open = true

        let store = new Store(() => {
            assert(open, `Transaction was already closed`)
            tx = tx || this.createTx(from, to)
            return tx.then(tx => tx.em)
        })

        try {
            await cb(store)
        } catch(e: any) {
            open = false
            if (tx) {
                await tx.then(t => t.rollback()).catch(err => null)
            }
            throw e
        }

        open = false
        if (tx) {
            await tx.then(t => t.commit())
            this.lastCommitted = to
        }
    }

    private async createTx(from: number, to: number): Promise<Tx> {
        let con = assertNotNull(this.con, 'not connected')
        let tx = await createTransaction(con, this.isolationLevel)

        try {
            await this.updateHeight(tx.em, from, to)
            return tx
        } catch(e: any) {
            await tx.rollback().catch(() => {})
            throw e
        }
    }

    async advance(height: number): Promise<void> {
        if (this.lastCommitted == height) return
        let tx = await this.createTx(height, height)
        await tx.commit()
    }
}


/**
 * Provides full TypeORM {@link EntityManager} to data handlers.
 *
 * Prefer using {@link TypeormDatabase} instead of this class when possible.
 *
 * Instances of this class should be considered to be completely opaque.
 */
export class FullTypeormDatabase extends BaseDatabase<EntityManager> {
    protected async runTransaction(from: number, to: number, cb: (store: EntityManager) => Promise<void>): Promise<void> {
        let con = assertNotNull(this.con, 'not connected')
        await con.transaction(this.isolationLevel, async em => {
            await this.updateHeight(em, from, to)
            await cb(em)
        })
        this.lastCommitted = to
    }

    async advance(height: number): Promise<void> {
        if (this.lastCommitted == height) return
        return this.runTransaction(height, height, async () => {})
    }
}
