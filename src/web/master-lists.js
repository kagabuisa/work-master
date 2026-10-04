'use strict';
// Master-data list/field configuration for the /settings master screens.
const { findMasterRecord, masterPriceLists, masterItemPrices, masterItems, masterCustomers, masterSuppliers, masterWarehouses, masterEmployees, masterCostCenters, masterOptions } = require('../store');

function masterListConfig(key) {
  const configs = {
    'price-lists': {
      key: 'price-lists', staticLabels: true, idField: 'price_list', title: 'Price Lists', singular: 'Price List',
      newLabel: 'New Price List', editLabel: 'Edit Price List', createSubmitLabel: 'Save', editSubmitLabel: 'Save',
      finder: (id) => findMasterRecord('price-lists', id),
      loader: (options) => masterPriceLists({ ...options, includeDisabled: true }),
      columns: [
        { key: 'price_list', label: 'Price List', strong: true },
        { key: 'currency', label: 'Currency' },
        { key: 'type_label', label: 'Buying/Selling' },
        { key: 'pricelist_type', label: 'Pricelist Type', fallback: 'Unspecified' },
      ],
      fields: [
        { name: 'price_list', label: 'Price List Name', required: true, maxlength: 140, lockedOnEdit: true, placeholder: 'Retail Selling' },
        { name: 'currency', label: 'Currency', required: true, maxlength: 3, placeholder: 'UGX' },
        { name: 'price_type', label: 'Buying/Selling', type: 'select', required: true, options: [
          { value: 'selling', label: 'Selling' }, { value: 'buying', label: 'Buying' }, { value: 'both', label: 'Buying and Selling' },
        ] },
        { name: 'pricelist_type', label: 'Pricelist Type', type: 'select', required: true, options: [
          { value: '', label: 'Select pricelist type' },
          { value: 'Retail', label: 'Retail' }, { value: 'Wholesale', label: 'Wholesale' },
          { value: 'Distribution', label: 'Distribution' },
        ] },
      ],
      hint: 'The name stays fixed after creation. Currency can change until item prices are added.',
    },
    'item-prices': {
      key: 'item-prices', staticLabels: true, idField: 'id', title: 'Item Prices', singular: 'Item Price',
      newLabel: 'New Item Price', editLabel: 'Edit Item Price',
      finder: (id) => findMasterRecord('item-prices', id),
      loader: (options) => masterItemPrices({ ...options, includeDisabled: true }),
      columns: [
        { key: 'item_code', label: 'Item Code', strong: true },
        { key: 'price_list', label: 'Price List' }, { key: 'currency', label: 'Currency' },
        { key: 'stock_uom', label: 'UOM' }, { key: 'price_list_rate', label: 'Rate' },
      ],
      fields: [
        { name: 'item_code', label: 'Item', section: 'Item and rate', required: true, lookup: '/api/pricing-items', placeholder: 'Search item code or name' },
        { name: 'price_list', label: 'Price List', required: true, lookup: '/api/price-lists?item_price=1', placeholder: 'Search active price lists' },
        { name: 'price_list_rate', label: 'Rate (price list currency)', type: 'number', required: true, min: 0, step: '0.000001' },
        { name: 'item_name', label: 'Item Name' },
        { name: 'item_description', label: 'Item Description', type: 'textarea', className: 'wide' },
        { name: 'currency', label: 'Currency', maxlength: 3 },
        { name: 'buying', label: 'Buying', type: 'select', options: [
          { value: '', label: 'From price list' }, { value: '1', label: 'Yes' }, { value: '0', label: 'No' },
        ] },
        { name: 'selling', label: 'Selling', type: 'select', options: [
          { value: '', label: 'From price list' }, { value: '1', label: 'Yes' }, { value: '0', label: 'No' },
        ] },
        { name: 'price_type', label: 'Price Type' },
        { name: 'erpnext_type', label: 'ERPNext Type', editOnly: true, readonly: true },
        { name: 'item_category', label: 'Item Category' },
        { name: 'cost_center', label: 'Cost Center', section: 'Cost and price history' },
        { name: 'cost', label: 'Cost', type: 'number', step: '0.000001' },
        { name: 'unit_cost', label: 'Unit Cost', type: 'number', step: '0.000001' },
        { name: 'new_price', label: 'New Price', type: 'number', step: '0.000001' },
        { name: 'old_price', label: 'Old Price', type: 'number', step: '0.000001' },
        { name: 'margin', label: 'Margin', type: 'number', step: '0.000001' },
        { name: 'price_update', label: 'Price Update' },
        { name: 'price_update_on', label: 'Price Update On', type: 'date' },
        { name: 'stock_balance', label: 'Stock Balance', section: 'Stock and packaging', type: 'number', step: '0.000001' },
        { name: 'incarton', label: 'In Carton', type: 'number', step: '0.000001' },
        { name: 'carton_price', label: 'Carton Price', type: 'number', step: '0.000001' },
        { name: 'dealer_price', label: 'Dealer Price', type: 'number', step: '0.000001' },
        { name: 'promo_start_date', label: 'Promo Start Date', section: 'Promotion', type: 'date' },
        { name: 'promo_expiry_date', label: 'Promo Expiry Date', type: 'date' },
        { name: 'promo_warehouse', label: 'Promo Warehouse' },
        { name: 'promo_customer', label: 'Promo Customer' },
        { name: 'warehouse_type', label: 'Warehouse Type' },
        { name: 'promo_rate', label: 'Promo Rate', type: 'number', step: '0.000001' },
        { name: 'promo_qty', label: 'Promo Qty', type: 'number', step: '0.000001' },
        { name: 'erpnext_name', label: 'ERPNext ID', section: 'ERPNext source', editOnly: true, readonly: true },
        { name: 'erpnext_created_at', label: 'ERPNext Created', editOnly: true, readonly: true },
        { name: 'erpnext_modified_at', label: 'ERPNext Modified', editOnly: true, readonly: true },
        { name: 'erpnext_owner', label: 'ERPNext Owner', editOnly: true, readonly: true },
        { name: 'erpnext_modified_by', label: 'ERPNext Modified By', editOnly: true, readonly: true },
      ],
      hint: 'An active item price overrides the item’s default base rate for this price list. New item prices are saved inactive.',
    },
    items: {
      key: 'items',
      idField: 'item_code',
      title: 'Items',
      singular: 'Item',
      newLabel: 'New Item',
      editLabel: 'Edit Item',
      finder: (id) => findMasterRecord('items', id),
      loader: (options) => masterItems({ ...options, includeDisabled: true }),
      columns: [
        { key: 'item_code', label: 'Code', strong: true },
        { key: 'item_name', label: 'Item' },
        { key: 'stock_uom', label: 'UOM' },
        { key: 'category', label: 'Item Category' },
        { key: 'source', label: 'Source' },
        { key: 'default_rate', label: 'Default Rate' },
        { key: 'unit_cost', label: 'Cost' },
        { key: 'status', label: 'Status' },
      ],
      fields: [
        { name: 'item_code', label: 'Item Code', required: true, placeholder: 'ITEM-001', lockedOnEdit: true },
        { name: 'item_name', label: 'Item Name', required: true, placeholder: 'Finished Product' },
        { name: 'stock_uom', label: 'Stock UOM', placeholder: 'Nos', optionGroup: 'stock_uom' },
        { name: 'category', label: 'Item Category', placeholder: 'Products', optionGroup: 'item_category' },
        { name: 'default_rate', label: 'Default Rate', type: 'number', step: '1', min: '0', placeholder: '0' },
        { name: 'unit_cost', label: 'Cost', type: 'number', step: '1', min: '0', placeholder: '0' },
        { name: 'markup', label: 'Markup', type: 'number', step: '0.01', min: '0', placeholder: '0' },
        { name: 'qty_per_carton', label: 'Qty per Carton', type: 'number', step: '0.001', min: '0', placeholder: '0' },
        { name: 'cbm_per_carton', label: 'CBM per Carton', type: 'number', step: '0.001', min: '0', placeholder: '0' },
        { name: 'weight_per_carton', label: 'Weight per Carton', type: 'number', step: '0.001', min: '0', placeholder: '0' },
        { name: 'import_fob', label: 'Import FOB', type: 'number', step: '0.01', min: '0', placeholder: '0' },
        { name: 'exporter', label: 'Exporter', placeholder: 'Exporter name' },
        {
          name: 'source',
          label: 'Source',
          type: 'select',
          options: [
            { value: '', label: '' },
            { value: 'Local', label: 'Local' },
            { value: 'Import', label: 'Import' },
          ],
        },
        { name: 'photo_count_id', label: 'Photo Count ID', placeholder: 'Photo Count ID' },
        { name: 'description', label: 'Description', type: 'textarea', className: 'wide' },
        {
          name: 'disabled',
          label: 'Status',
          type: 'select',
          options: [
            { value: '0', label: 'Enabled' },
            { value: '1', label: 'Disabled' },
          ],
        },
      ],
    },
    customers: {
      key: 'customers',
      idField: 'customer_id',
      title: 'Customers',
      singular: 'Customer',
      newLabel: 'New Customer',
      editLabel: 'Edit Customer',
      finder: (id) => findMasterRecord('customers', id),
      loader: (options) => masterCustomers({ ...options, includeDisabled: true }),
      columns: [
        { key: 'customer_name', label: 'Customer', strong: true, secondaryKey: 'customer_id' },
        { key: 'tin', label: 'TIN' },
        { key: 'customer_group', label: 'Group' },
        { key: 'territory', label: 'Territory' },
        { key: 'phone', label: 'Phone' },
        { key: 'status', label: 'Status' },
      ],
      fields: [
        { name: 'customer_id', label: 'Customer ID', placeholder: 'Leave blank to use customer name', lockedOnEdit: true },
        { name: 'customer_name', label: 'Customer Name', required: true, placeholder: 'Customer Ltd' },
        { name: 'tin', label: 'TIN (Tax Identification Number)', maxlength: 100 },
        { name: 'customer_group', label: 'Group', placeholder: 'Commercial', optionGroup: 'customer_group' },
        { name: 'territory', label: 'Territory', placeholder: 'Uganda', optionGroup: 'territory' },
        { name: 'phone', label: 'Phone', autocomplete: 'tel' },
        {
          name: 'disabled',
          label: 'Status',
          type: 'select',
          options: [
            { value: '0', label: 'Active' },
            { value: '1', label: 'Inactive' },
          ],
        },
      ],
    },
    suppliers: {
      key: 'suppliers',
      idField: 'supplier_id',
      title: 'Suppliers',
      singular: 'Supplier',
      newLabel: 'New Supplier',
      editLabel: 'Edit Supplier',
      finder: (id) => findMasterRecord('suppliers', id),
      loader: (options) => masterSuppliers({ ...options, includeDisabled: true }),
      columns: [
        { key: 'supplier_id', label: 'ID', strong: true },
        { key: 'supplier_name', label: 'Supplier' },
        { key: 'supplier_type', label: 'Type' },
        { key: 'phone', label: 'Phone' },
        { key: 'status', label: 'Status' },
      ],
      fields: [
        { name: 'supplier_id', label: 'Supplier ID', placeholder: 'Leave blank to use supplier name', lockedOnEdit: true },
        { name: 'supplier_name', label: 'Supplier Name', required: true, placeholder: 'Supplier Ltd' },
        { name: 'supplier_type', label: 'Type', placeholder: 'Local', optionGroup: 'supplier_type' },
        { name: 'phone', label: 'Phone', autocomplete: 'tel' },
        {
          name: 'disabled',
          label: 'Status',
          type: 'select',
          options: [
            { value: '0', label: 'Active' },
            { value: '1', label: 'Inactive' },
          ],
        },
      ],
    },
    warehouses: {
      key: 'warehouses',
      idField: 'warehouse',
      title: 'Warehouses',
      singular: 'Warehouse',
      newLabel: 'New Warehouse',
      editLabel: 'Edit Warehouse',
      finder: (id) => findMasterRecord('warehouses', id),
      loader: (options) => masterWarehouses({ ...options, includeDisabled: true }),
      columns: [
        { key: 'warehouse', label: 'Warehouse', strong: true },
        { key: 'warehouse_type', label: 'Type' },
        { key: 'status', label: 'Status' },
      ],
      fields: [
        { name: 'warehouse', label: 'Warehouse Name', required: true, placeholder: 'Main Warehouse', lockedOnEdit: true },
        { name: 'warehouse_type', label: 'Warehouse Type', type: 'option-select', optionGroup: 'warehouse_type' },
        {
          name: 'disabled',
          label: 'Status',
          type: 'select',
          options: [
            { value: '0', label: 'Enabled' },
            { value: '1', label: 'Disabled' },
          ],
        },
      ],
    },
    employees: {
      key: 'employees',
      idField: 'employee_id',
      title: 'Employees',
      singular: 'Employee',
      newLabel: 'New Employee',
      editLabel: 'Edit Employee',
      finder: (id) => findMasterRecord('employees', id),
      loader: (options) => masterEmployees({ ...options, includeDisabled: true }),
      columns: [
        { key: 'employee_id', label: 'ID', strong: true },
        { key: 'employee_name', label: 'Employee' },
        { key: 'department', label: 'Department' },
        { key: 'designation', label: 'Designation' },
        { key: 'phone', label: 'Phone' },
        { key: 'status_label', label: 'Status' },
      ],
      fields: [
        { name: 'employee_id', label: 'Employee ID', placeholder: 'Leave blank to use employee name', lockedOnEdit: true },
        { name: 'employee_name', label: 'Employee Name', required: true, placeholder: 'Employee Name' },
        { name: 'status', label: 'Employment Status', placeholder: 'Active' },
        { name: 'company', label: 'Company', placeholder: 'Company name' },
        { name: 'department', label: 'Department', placeholder: 'Department' },
        { name: 'designation', label: 'Designation', placeholder: 'Role / title' },
        { name: 'phone', label: 'Phone', autocomplete: 'tel' },
        { name: 'email', label: 'Email', type: 'email', autocomplete: 'email' },
        {
          name: 'disabled',
          label: 'Status',
          type: 'select',
          options: [
            { value: '0', label: 'Active' },
            { value: '1', label: 'Inactive' },
          ],
        },
      ],
    },
    'cost-centers': {
      key: 'cost-centers',
      idField: 'cost_center',
      title: 'Cost Centers',
      singular: 'Cost Center',
      newLabel: 'New Cost Center',
      editLabel: 'Edit Cost Center',
      finder: (id) => findMasterRecord('cost-centers', id),
      loader: (options) => masterCostCenters({ ...options, includeGroups: true, includeDisabled: true }),
      columns: [
        { key: 'cost_center_name', label: 'Cost Center', strong: true, secondaryKey: 'cost_center' },
        { key: 'parent_cost_center', label: 'Parent' },
        { key: 'company', label: 'Company' },
        { key: 'cost_center_type', label: 'Type' },
        { key: 'group_label', label: 'Group' },
        { key: 'status', label: 'Status' },
      ],
      fields: [
        { name: 'cost_center', label: 'Cost Center ID', placeholder: 'Leave blank to use cost center name', lockedOnEdit: true },
        { name: 'cost_center_name', label: 'Cost Center Name', required: true },
        { name: 'parent_cost_center', label: 'Parent Cost Center' },
        { name: 'company', label: 'Company' },
        { name: 'cost_center_type', label: 'Cost Center Type' },
        { name: 'is_group', label: 'Group', type: 'select', options: [
          { value: 'false', label: 'No', defaultValue: 'false' },
          { value: 'true', label: 'Yes' },
        ] },
      ],
    },
    options: {
      key: 'options',
      idField: 'id',
      title: 'Options',
      singular: 'Option',
      newLabel: 'New Option',
      editLabel: 'Edit Option',
      finder: (id) => findMasterRecord('options', id),
      loader: (options) => masterOptions({ ...options, includeDisabled: true }),
      columns: [
        { key: 'option_group', label: 'Group', strong: true },
        { key: 'option_value', label: 'Value' },
      ],
      fields: [
        { name: 'option_group', label: 'Group', required: true, placeholder: 'item_category', optionGroup: 'option_group' },
        { name: 'option_value', label: 'Value', required: true, placeholder: 'Finished Goods' },
      ],
    },
  };
  const config = configs[key];
  if (!config) {
    const err = new Error('Master list not found.');
    err.status = 404;
    throw err;
  }
  config.staticLabels = true;
  config.createSubmitLabel = 'Save';
  config.editSubmitLabel = 'Update';
  config.fields = config.fields.filter((field) => field.name !== 'disabled');
  config.columns = config.columns.filter((column) => !['status', 'status_label'].includes(column.key));
  return config;
}


module.exports = { masterListConfig };
