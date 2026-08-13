import {type PoolConnection } from "mysql2/promise";
import { closePool, withRollback } from "../helpers/db";
import test, { after } from "node:test";
import { nanonetsSql } from "@/lib/queries/nanonets";
import assert from "node:assert/strict";

async function tableMissing(conn : PoolConnection) : Promise<boolean> {
    const [rows] = await conn.query(
        `Select count(*) as n from information_schema.tables
         where table_schema = DATABASE() and table_name = 'nanonets_usage'
        `
    )
    return Number((rows as { n : number } [])[0]?.n ?? 0) === 0
}   

const calls = async (conn:PoolConnection , sql: string): Promise<number> => {
    const [rows] = await conn.query(sql)
    return Number((rows  as { calls: number }[])[0]?.calls ?? 0)
} 

test("increament creates today's row , then adds to it" , async () => {
    await withRollback(async (conn) => {
        if(await tableMissing(conn)) {
            console.log("  skipped — run prisma/add_nanonets_usage.sql on this schema first")
            return
        }

        const before = await calls(conn , nanonetsSql.selectToday)
        await conn.query(nanonetsSql.increament)
        assert.equal(await calls(conn , nanonetsSql.selectToday) , before +1 )

        await conn.query(nanonetsSql.increament)
        assert.equal (
            await calls(conn , nanonetsSql.selectToday) , before + 2 , 
            "ON DUBLICATE KEY must add, now replace - the day is the primary key"
        )
    })
})

test("the month total spans days and ignores last month", async () => {
  await withRollback(async (conn) => {
    if (await tableMissing(conn)) return

    const before = await calls(conn, nanonetsSql.selectMonthToal)

    // A day earlier this month counts; a day last month must not.
    await conn.query(
      `INSERT INTO nanonets_usage (day, calls)
       VALUES (DATE_FORMAT(CURDATE(), '%Y-%m-01'), 5)
       ON DUPLICATE KEY UPDATE calls = calls + 5`
    )
    await conn.query(
      `INSERT INTO nanonets_usage (day, calls)
       VALUES (DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m-01'), 99)
       ON DUPLICATE KEY UPDATE calls = calls + 99`
    )

    assert.equal(
      await calls(conn, nanonetsSql.selectMonthToal), before + 5,
      "last month's 99 calls must not count against this month's quota"
    )
  })
})

after(closePool)