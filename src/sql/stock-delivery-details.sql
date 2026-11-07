ALTER TABLE app_stock_entry_delivery
  ADD COLUMN IF NOT EXISTS delivery_details JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE app_stock_entry_delivery
  DROP CONSTRAINT IF EXISTS app_stock_entry_delivery_delivery_status_check;

ALTER TABLE app_stock_entry_delivery
  ADD CONSTRAINT app_stock_entry_delivery_delivery_status_check
  CHECK (delivery_status IN (
    '', 'Picked & packed', 'In Transit', 'Delivered', 'All Received', 'Received + DDR'
  ));
