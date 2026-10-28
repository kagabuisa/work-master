'use strict';
function loadEnvironment() {
  let database=process.env.PGDATABASE||process.env.POSTGRES_DB||'';
  const url=process.env.POSTGRES_RUNTIME_URL||process.env.POSTGRES_URL||process.env.DATABASE_URL;
  if(url){try{database=decodeURIComponent(new URL(url).pathname.slice(1));}catch{}}
  // Isolated integration runners explicitly supply their database. Never mix
  // application runtime credentials or its .env into that test environment.
  if(/_hr_test$/.test(database))return;
  require('dotenv').config({quiet:true});
}
module.exports={loadEnvironment};
