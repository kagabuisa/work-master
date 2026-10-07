'use strict';

async function activePermissionPriceLists(client) {
  const { rows } = await client.query(`SELECT price_list FROM app_master_price_lists
    WHERE active = 1 AND docstatus = 'submitted' ORDER BY price_list`);
  return rows;
}

module.exports = { activePermissionPriceLists };
