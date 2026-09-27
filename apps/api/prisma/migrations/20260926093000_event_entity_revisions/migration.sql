-- 为活动事件补充实体修订号，使每个业务对象的版本链可以从事件历史重放复算。
-- 存量事件按 (entity_type, entity_id) 分组、以 (occurred_at, id) 稳定排序回填，
-- 与既有行上的 version 递增序列一一对应（每次版本递增都恰好写入一条事件）。

ALTER TABLE "activity_events" ADD COLUMN "entity_version" INTEGER;

WITH numbered AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "entity_type", "entity_id"
      ORDER BY "occurred_at" ASC, "id" ASC
    ) AS "revision"
  FROM "activity_events"
)
UPDATE "activity_events" AS "event"
SET "entity_version" = "numbered"."revision"
FROM "numbered"
WHERE "event"."id" = "numbered"."id";

ALTER TABLE "activity_events" ALTER COLUMN "entity_version" SET NOT NULL;

CREATE INDEX "activity_events_entity_type_entity_id_entity_version_idx"
  ON "activity_events"("entity_type", "entity_id", "entity_version");

-- 同一实体的事件版本号必须唯一，保证修订链可重放、冲突判定可复算。
CREATE UNIQUE INDEX "activity_events_entity_revision_key"
  ON "activity_events"("entity_type", "entity_id", "entity_version")
  WHERE "entity_id" IS NOT NULL;
