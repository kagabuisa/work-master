'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {paginationOptions,paginationWindow}=require('../src/lib/pagination');
const ejs=require('ejs'),fs=require('node:fs');
test('count-free pagination handles first, full, empty and out-of-range pages',()=>{
 assert.equal(paginationWindow(2,paginationOptions({page_size:1})).has_next,true);
 assert.equal(paginationWindow(1,paginationOptions({page_size:1})).has_next,false);
 const empty=paginationWindow(0,paginationOptions({page:3,page_size:1}));
 assert.equal(empty.has_previous,true);assert.equal(empty.start,0);assert.equal(empty.end,0);
});
test('count-free navigation preserves filters and offers exact totals without carrying counts to Next',()=>{
 const html=ejs.render(fs.readFileSync('views/pagination.ejs','utf8'),{pagination:paginationWindow(3,paginationOptions({page_size:2})),query:{q:'Customer',exact_total:'1'},basePath:'/invoices'});
 assert.match(html,/Calculate total/);assert.match(html,/Page 1/);assert.doesNotMatch(html,/of null/);
 assert.match(html,/q=Customer[^"<>]*page=2/);assert.doesNotMatch(html,/exact_total=1[^"<>]*page=2/);
});
