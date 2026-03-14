-- Fix bot-sent synthetic events that had utcOffsetMin hardcoded to 0 (UTC)
-- instead of the correct local timezone. The bot runs in UTC+08:00.
UPDATE `events` SET `utc_offset_min` = 480 WHERE `utc_offset_min` = 0;
