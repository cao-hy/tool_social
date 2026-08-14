ALTER TABLE "OutboxEvent" ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "OutboxEvent_dedupeKey_key" ON "OutboxEvent"("dedupeKey");
