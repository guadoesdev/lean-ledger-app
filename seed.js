// Run once: npm run seed
const dv = require('./supabase');

// name, serving, kcal, protein, carbs, fat, sodium mg, fiber
const SEED = [
['Egg, large','1 egg',72,6.3,.4,4.8,71,0],['Chicken breast, cooked','100 g',165,31,0,3.6,74,0],
['Greek yogurt, nonfat','170 g',100,17,6,.7,60,0],['Oats, dry','40 g',150,5,27,3,2,4],
['Brown rice, cooked','1 cup',215,5,45,1.8,10,3.5],['White rice, cooked','1 cup',205,4.3,45,.4,2,.6],
['Banana, medium','1 banana',105,1.3,27,.4,1,3],['Apple, medium','1 apple',95,.5,25,.3,2,4.4],
['Whole milk','1 cup',150,8,12,8,105,0],['Whey protein powder','1 scoop (30 g)',120,24,3,1.5,130,0],
['Salmon, cooked','100 g',206,22,0,12,59,0],['Tuna, canned in water','1 can (120 g)',120,26,0,1,320,0],
['Lean ground beef 93%, cooked','100 g',190,26,0,9,75,0],['Tofu, firm','100 g',144,17,3,9,14,2],
['Lentils, cooked','1 cup',230,18,40,.8,4,16],['Black beans, canned','½ cup',110,7,20,.5,440,6],
['Sweet potato, baked','1 medium',112,2,26,.1,72,3.9],['Potato, boiled','150 g',130,3,30,.2,8,3],
['Broccoli, cooked','1 cup',55,3.7,11,.6,64,5],['Spinach, raw','2 cups',14,1.7,2.2,.2,48,1.4],
['Whole-wheat bread','1 slice',80,4,14,1,150,2],['Olive oil','1 tbsp',119,0,0,13.5,0,0],
['Peanut butter','2 tbsp',190,7,7,16,140,2],['Almonds','28 g',164,6,6,14,0,3.5],
['Cheddar cheese','28 g',113,7,.4,9,174,0],['Cottage cheese, low-fat','½ cup',90,12,5,1.2,350,0],
['Avocado','½ avocado',120,1.5,6,11,5,5],['Pasta, cooked','1 cup',220,8,43,1.3,1,2.5],
['Soy sauce','1 tbsp',9,1,1,0,879,.1]
];

(async () => {
  if (await dv.hasBuiltInFoods()) return console.log('Built-in foods already loaded. Nothing to do.');
  for (const [n, s, k, p, c, f, na, fi] of SEED) await dv.createFood(null, { n, s, k, p, c, f, na, fi });
  console.log(`Loaded ${SEED.length} foods.`);
})().catch(e => { console.error(e); process.exit(1); });
