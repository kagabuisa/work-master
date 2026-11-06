'use strict';

const express = require('express');
const { listSharedVouchers } = require('../../voucher-sharing');
const { money } = require('../format');

const router = express.Router();

router.get('/shared-vouchers', async (req, res, next) => {
  try {
    const result = await listSharedVouchers(req.currentUser, req.query);
    res.set('Cache-Control', 'private, no-store');
    res.render('shared-vouchers', { result, query: req.query, money });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
