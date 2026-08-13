CREATE TABLE IF NOT EXISTS nanonets_usage (
    day DateTime @id @db.DATE
    calls Int @DEFAULT(0)
)


