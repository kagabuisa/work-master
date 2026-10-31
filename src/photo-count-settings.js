'use strict';
const {getPostgresPool}=require('./core');
const MAX_DESCRIPTION_LENGTH=30000;
async function getPhotoCountSettings(client=getPostgresPool()){
 const row=(await client.query('SELECT ai_count_descriptions FROM app_display_settings WHERE id=1')).rows[0];
 return {descriptions:row?.ai_count_descriptions||''};
}
async function savePhotoCountSettings(user,body,client=getPostgresPool()){
 if(user?.role!=='admin'){const error=new Error('Only an administrator can change AI counting descriptions.');error.status=403;throw error;}
 const descriptions=String(body.descriptions??'').replace(/\r\n?/g,'\n').trim();
 if(descriptions.length>MAX_DESCRIPTION_LENGTH){const error=new Error('Item and carton descriptions must be 30,000 characters or fewer.');error.status=400;throw error;}
 await client.query(`INSERT INTO app_display_settings(id,ai_count_descriptions) VALUES(1,$1)
   ON CONFLICT(id) DO UPDATE SET ai_count_descriptions=EXCLUDED.ai_count_descriptions`,[descriptions]);
 return {descriptions};
}
module.exports={getPhotoCountSettings,savePhotoCountSettings,MAX_DESCRIPTION_LENGTH};
