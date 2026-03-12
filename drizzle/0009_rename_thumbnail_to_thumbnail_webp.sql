-- Rename "thumbnail" key to "thumbnailWebp" in attachments JSON (messages + events tables).
-- SQLite json_replace + json_extract approach: copy the value, remove old key.

-- messages.attachments: array of platform Attachment objects
UPDATE `messages`
SET `attachments` = (
  SELECT json_group_array(
    CASE
      WHEN json_extract(value, '$.thumbnail') IS NOT NULL
      THEN json_remove(json_set(value, '$.thumbnailWebp', json_extract(value, '$.thumbnail')), '$.thumbnail')
      ELSE value
    END
  )
  FROM json_each(`attachments`)
)
WHERE `attachments` IS NOT NULL
  AND `attachments` LIKE '%"thumbnail"%';

--> statement-breakpoint

-- events.attachments: array of CanonicalAttachment objects
UPDATE `events`
SET `attachments` = (
  SELECT json_group_array(
    CASE
      WHEN json_extract(value, '$.thumbnail') IS NOT NULL
      THEN json_remove(json_set(value, '$.thumbnailWebp', json_extract(value, '$.thumbnail')), '$.thumbnail')
      ELSE value
    END
  )
  FROM json_each(`attachments`)
)
WHERE `attachments` IS NOT NULL
  AND `attachments` LIKE '%"thumbnail"%';
