const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCoordinates } = require('../utils/addressCoordinates');
const { normalizeCheckoutAddress, validateCheckoutLocation } = require('../utils/checkoutLocation');
const { normalizeGeoapifySuggestion } = require('../utils/locationSuggestions');
const good = { address: '3rd Avenue', city: 'Abuja', country: 'Nigeria' };
for (const [name, point, accepted] of [
 ['valid', [9.08,7.46],true], ['zero latitude',[0,7],true], ['zero longitude',[9,0],true],
 ['null',[null,7],false], ['NaN',[NaN,7],false], ['infinity',[9,Infinity],false],
 ['latitude range',[91,7],false], ['longitude range',[9,-181],false],
 ['zero pair',[0,0],false], ['boolean',[false,7],false], ['blank',[' ',7],false],
 ['numeric strings',['9.08','7.46'],true]]) {
 test('checkout location: '+name, () => {
  const error = validateCheckoutLocation(good, { latitude: point[0], longitude: point[1] });
  assert.equal(!error,accepted);
 });
}
test('postal/state/area are optional, usable address/city/country are required', () => {
 assert.equal(validateCheckoutLocation(good,{latitude:9,longitude:7}),null);
 for (const key of ['address','city','country']) assert.ok(validateCheckoutLocation({...good,[key]:''},{latitude:9,longitude:7}));
 assert.deepEqual(validateCoordinates(undefined,undefined),{latitude:undefined,longitude:undefined});
});
test('structured fields are preserved without invented missing values', () => {
 const value=normalizeCheckoutAddress({...good, street:' Avenue ',area:' Gwarinpa ',landmark:' Gate ',state:'FCT',postalCode:null});
 assert.equal(value.street,'Avenue'); assert.equal(value.area,'Gwarinpa');assert.equal(value.state,'FCT');assert.equal(value.postalCode,'');
});
test('provider fields map to structured fields, missing data stays empty', () => {
 const row=normalizeGeoapifySuggestion({lat:9,lon:7,address_line1:'3rd Avenue',city:'Abuja',street:'Avenue',suburb:'Gwarinpa',state:'FCT',country:'Nigeria',formatted:'3rd Avenue, Abuja'});
 assert.equal(row.street,'Avenue');assert.equal(row.area,'Gwarinpa');assert.equal(row.state,'FCT');assert.equal(row.landmark,'');assert.equal(row.postalCode,'');
 const partial=normalizeGeoapifySuggestion({lat:9,lon:7,formatted:'Address'});assert.equal(partial.country,'');assert.equal(partial.state,'');assert.equal(partial.area,'');
 for(const lat of [null,' ',NaN,Infinity,91,false]) assert.equal(normalizeGeoapifySuggestion({lat,lon:7,formatted:'Address'}),null);
});
test('saved-address schema accepts absent postal and preserves structured fields', () => {
 const User=require('../models/User');
 const doc=new User({deliveryAddresses:[{...good,phoneNumber:'test',street:'Avenue',area:'Gwarinpa',state:'FCT',latitude:9,longitude:7}]});
 assert.equal(doc.deliveryAddresses[0].postalCode,'');assert.equal(doc.deliveryAddresses[0].state,'FCT');
 assert.equal(User.schema.path('deliveryAddresses').schema.path('postalCode').isRequired,undefined);
});

test('reverse API returns structured address, retains requested position and rejects zero', async () => {
 const fs=require('node:fs'),vm=require('node:vm');const handlers={};let calls=0;
 const router={get(path,...middleware){handlers[path]=middleware.at(-1);}};
 const dependencies={express:{Router:()=>router},axios:{get:async()=>{calls++;return {data:{results:[{address_line1:'3rd Avenue',street:'Avenue',suburb:'Gwarinpa',city:'Abuja',state:'FCT',country:'Nigeria'}]}};}},'express-rate-limit':{rateLimit:()=>()=>{}},'../middleware/authMiddleware':{protect:()=>{}},'../utils/locationSuggestions':require('../utils/locationSuggestions')};
 vm.runInNewContext(fs.readFileSync(require.resolve('../routes/locationRoutes'),'utf8'),{require:name=>dependencies[name],module:{exports:{}},process:{env:{GEOAPIFY_API_KEY:'isolated-test-placeholder'}},console,Map,Set,Date,Number,String,Math});
 const response=()=>({statusCode:200,status(n){this.statusCode=n;return this;},json(data){this.data=data;return this;}});
 const res=response();await handlers['/reverse']({query:{lat:'9.08',lng:'7.46'}},res);assert.equal(res.statusCode,200);assert.equal(res.data.address.street,'Avenue');assert.equal(res.data.address.area,'Gwarinpa');assert.equal(res.data.address.state,'FCT');assert.equal(res.data.address.postalCode,'');assert.equal(res.data.address.landmark,'');assert.equal(res.data.address.latitude,9.08);assert.equal(res.data.address.longitude,7.46);
 const zero=response();await handlers['/reverse']({query:{lat:'0',lng:'0'}},zero);assert.equal(zero.statusCode,400);assert.equal(calls,1);
});

test('saved-address API accepts optional postal, preserves coordinates and rejects zero pair', async () => {
 const fs=require('node:fs'),vm=require('node:vm');const source=fs.readFileSync(require.resolve('../routes/authRoutes'),'utf8');
 const handlers={};const router={post(path,...middleware){handlers[path]=middleware.at(-1);}};
 let saves=0;const user={deliveryAddresses:[],save:async()=>{saves++;}};
 const context={router,protect:()=>{},User:{findById:async()=>user},validateCoordinates,normalizeCheckoutAddress,console};
 const start=source.indexOf("router.post('/addresses',");const end=source.indexOf('\n});',start);vm.runInNewContext(source.slice(start,end+4),context);
 const response=()=>({statusCode:200,status(n){this.statusCode=n;return this;},json(data){this.data=data;return this;}});
 const res=response();await handlers['/addresses']({body:{...good,area:'Gwarinpa',state:'FCT',latitude:9.08,longitude:7.46},user:{_id:'local-test'}},res);
 assert.equal(res.statusCode,201);assert.equal(user.deliveryAddresses[0].postalCode,'');assert.equal(user.deliveryAddresses[0].area,'Gwarinpa');assert.equal(user.deliveryAddresses[0].latitude,9.08);assert.equal(saves,1);
 const zero=response();await handlers['/addresses']({body:{...good,latitude:0,longitude:0},user:{_id:'local-test'}},zero);assert.equal(zero.statusCode,400);assert.equal(saves,1);
});
