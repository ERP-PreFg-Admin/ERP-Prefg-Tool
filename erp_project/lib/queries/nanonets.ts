export const nanonetsSql = {
    /**Params: [] */
    selectToday : `
        SELECT calls from nanonets_usage WHERE day = CURDATE()
    `,
    /** Params: [] — calls so far this calendar month. */
    selectMonthToal : `
        Select COALESCE(SUM(calls) , 0) as calls
        from nanonets_usage
        WHERE day >= DATE_FORMAT(CURDATE() , '%Y-%m-01')    
    `,
    /** Params: [] - atomic increament; create today's row on the first call.*/
    increament : `
        INSERT INTO nanonets_usage (day, calls) VALUES (CURDATE() , 1)
        ON DUPLICATE KEY UPDATE calls = calls + 1
    `

}