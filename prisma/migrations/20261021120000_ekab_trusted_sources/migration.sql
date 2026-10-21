-- Default trusted sources for the Track B scraper, so the admin's "Source websites" list is not
-- empty on a new database. Each was checked from the server on 2026-10-21: document pages return
-- 200 to the scraper's user agent and robots.txt allows the document paths. Inserted once (a
-- migration, not the seed), so a site an admin removes is not put back by a later deploy.
INSERT INTO "ekab_source_domains" ("host", "publisher", "default_source_type", "access_state", "enabled", "notes", "created_by")
VALUES
  ('.ti.com', 'Texas Instruments', 'APP_NOTE', 'PUBLIC', true,
   'Trusted default. Datasheets (/lit/ds/…) and application reports (/lit/an/…): interfaces, power, protection. Datasheet links are typed DATASHEET automatically.', 'system (trusted default)'),
  ('.rfc-editor.org', 'IETF (RFC Editor)', 'STANDARD', 'PUBLIC', true,
   'Trusted default. Published RFCs (/rfc/rfcNNNN.html): IP, TCP/UDP, CoAP, MQTT-SN references, TLS. Free to read.', 'system (trusted default)'),
  ('docs.espressif.com', 'Espressif Systems', 'OFFICIAL_DOC', 'PUBLIC', true,
   'Trusted default. ESP-IDF programming guide and peripheral docs (I2C, SPI, UART, TWAI/CAN) for ESP32 controllers.', 'system (trusted default)'),
  ('docs.zephyrproject.org', 'Zephyr Project', 'OFFICIAL_DOC', 'PUBLIC', true,
   'Trusted default. Official RTOS and driver documentation. robots.txt allows only /latest/… pages, so use /latest/ links.', 'system (trusted default)')
ON CONFLICT ("host") DO NOTHING;
