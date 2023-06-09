require('dotenv').config();
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const moment = require('moment-timezone');
const serviceAccount = require("./firebase_key.json"); // Firebase 서비스 계정 키 경로
const {Translate} = require('@google-cloud/translate').v2;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
moment.tz.setDefault("Asia/Seoul");
const db = admin.firestore();

exports.get3dayForecastDataAndSaveToDatabase = functions.region('asia-northeast3').pubsub
.schedule('10 5,11,17,23 * * *').timeZone("Asia/Seoul")
.onRun(async (context) => {
try {
  const url = "http://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getMinuDustFrcstDspth";
  const serviceKey = process.env.SERVICE_KEY;
  const numOfRows = "50";
  const ver = "1.1";
  const returnType = "json";
  const searchDate = moment().format("YYYY-MM-DD");
  const forecast = {};
  const translate = new Translate();
  let lastImageUrl7 = null;
  let lastImageUrl8 = null;
  let thumbnailImage= null;
  let informCause = null;
  const [pm10Response, pm25Response] = await Promise.all([
    axios.get(`${url}?serviceKey=${serviceKey}&returnType=${returnType}&searchDate=${searchDate}&numOfRows=${numOfRows}&ver=${ver}&informCode=PM10`),
    axios.get(`${url}?serviceKey=${serviceKey}&returnType=${returnType}&searchDate=${searchDate}&numOfRows=${numOfRows}&ver=${ver}&informCode=PM25`)
  ]);

  const processForecastData = (response, informCode) => {
    const items = response.data.response.body.items;
    const today = moment().format("YYYY-MM-DD");

    for (let i = 0; i < items.length; i++) {
      const time = items[i].dataTime.split(" ")[1].replace("시", "");
      const hour = moment().format("H");

      if (hour >= 23 && time < 23 || hour >= 17 && time < 17 || hour >= 11 && time < 11 || hour >= 5 && time < 5) {
        continue;
      }

      const informGradeArray = items[i].informGrade.split(',');
      const informData = items[i].informData;
      const value = mergeKoreaName(informGradeArray);
      
      if (informCode === "PM10") {
        const data = {};
        data.informData = informData;
        data.value = value;
        forecast[informData] = data;

        if (informData == today) {
          lastImageUrl7 = items[i].imageUrl7;
          thumbnailImage = items[i].imageUrl1;
          informCause = items[i].informCause.split(" ").slice(2).join(" ");
        }
      } else if (informCode === "PM25") {
        if (informData == today) {
          lastImageUrl8 = items[i].imageUrl8;
        }
      }

    }
  }

  processForecastData(pm10Response, "PM10");
  processForecastData(pm25Response, "PM25");
  if(lastImageUrl7 != null){
    forecast.PM10ImgUrl = lastImageUrl7;
  }
  if(lastImageUrl8 != null){
    forecast.PM25ImgUrl = lastImageUrl8;
  }  
  if(thumbnailImage != null){
    forecast.thumbnailImageUrl = thumbnailImage;
  }
  if(informCause != null){
    const target = 'en';
    let [translations] = await translate.translate(informCause, target);
    translations = Array.isArray(translations) ? translations : [translations];
    forecast.information = translations[0];
  }
  const dbRef = db.collection('forecast').doc('forecast');
  await dbRef.set(forecast,{merge: true});
  console.log(`3days data saved to database successfully.`);
} catch (error) {
  console.error(error);
}
});

exports.get4dayForecastDataAndSaveToDatabase = functions.region('asia-northeast3').pubsub
.schedule('31 17 * * *').timeZone('Asia/Seoul')
.onRun(async(context) =>{
  try {
    const url = "http://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getMinuDustWeekFrcstDspth";
    const serviceKey = process.env.SERVICE_KEY;
    const numOfRows = "50";
    const returnType = "json";
    const searchDate = moment().format("YYYY-MM-DD");
    const yesterDay = moment().subtract(1, 'days').format("YYYY-MM-DD");
    let item;
    let response = await axios.get(`${url}?serviceKey=${serviceKey}&returnType=${returnType}&searchDate=${searchDate}&numOfRows=${numOfRows}`);
    if(Array.isArray(response.data.response.body.items) && response.data.response.body.items.length > 0){
      item = response.data.response.body.items[0]; 
    }else{
      response = await axios.get(`${url}?serviceKey=${serviceKey}&returnType=${returnType}&searchDate=${yesterDay}&numOfRows=${numOfRows}`);
      item = response.data.response.body.items[0];
    }
    const frcstArr = [item.frcstOneCn.split(','),item.frcstTwoCn.split(','),item.frcstThreeCn.split(','),item.frcstFourCn.split(',')];
    const frcstDateArr = [item.frcstOneDt,item.frcstTwoDt,item.frcstThreeDt,item.frcstFourDt];
    const forecast = {};
    for (let i = 0; i < frcstArr.length; i++) {
      const data = {};
      data.value = mergeKoreaName(frcstArr[i]);
      forecast[frcstDateArr[i]] = data;
    }
    const dbRef = db.collection('forecast').doc('forecast');
    await dbRef.set(forecast,{merge: true});
    console.log(`4days data saved to database successfully.`);
  } catch (error) {
    console.error(error);
  }
});

function mergeKoreaName(array) {
  const value = {};
  for (const element of array) {
    let [region, grade] = element.split(':');
    region = region.trim();
    grade = grade.trim();
    if(region ==='신뢰도'){
      continue;
    }
    if (region === '영동' || region === '영서'|| region === '강원영동' || region === '강원영서') {
      region = '강원';
    } else if (region === '경기남부' || region === '경기북부') {
      region = '경기';
    }
    if (grade === '낮음'){
      grade = '좋음';
    }else if(grade === '높음'){
      grade = '나쁨';
    }
    if(grade === '매우나쁨'){
      grade = 'Very Unhealthy'
    }else if(grade === '나쁨'){
      grade = 'Unhealthy'
    }else if(grade === '보통'){
      grade = 'Moderate'
    }else if(grade === '좋음'){
      grade = 'Good'
    }
    if (value[region] != null) {
      if (grade === 'Good' || (grade === 'Moderate' && value[region] === 'Good') || (grade === 'Unhealthy' && (value[region] === 'Good' || value[region] === 'Moderate')) || (grade ==='Very Unhealthy' && (value[region] === 'Good' || value[region] === 'Moderate'||value[region] === 'Unhealthy'))) {
        value[region] = grade;
      }
    } else {
      value[region] = grade;
    }
  }
  return value;
};

exports.getAirDataAndSaveToDatabase = functions.region('asia-northeast3').pubsub
.schedule('0,15,30,45 * * * *').timeZone('Asia/Seoul')
.onRun(async (context) => {
  try {
    const url = "http://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty";
    const serviceKey = process.env.SERVICE_KEY;
    const numOfRows = "1000";
    const ver = "1.2";
    const returnType = "json";
    const sidoName = "전국";
    const response = await axios.get(`${url}?serviceKey=${serviceKey}&returnType=${returnType}&sidoName=${sidoName}&numOfRows=${numOfRows}&ver=${ver}`); 
    const items = response.data.response.body.items;
    for(let i =0; i< items.length;i++){
      const stationName= items[i].stationName;

      const data = {
        sidoName: items[i].sidoName,
        dataTime: changeDateFormat(items[i].dataTime),
        pm10Value: items[i].pm10Value,
        pm25Value: items[i].pm25Value,
        no2Value: items[i].no2Value,
        so2Value: items[i].so2Value,
        coValue: items[i].coValue,
        o3Value: items[i].o3Value,
        khaiValue: items[i].khaiValue,
        pm10Grade: getGradeFromValue(items[i].pm10Value, [30, 70, 100, 150, 200]),
        pm25Grade: getGradeFromValue(items[i].pm25Value, [15, 35, 50, 75, 100]),
        no2Grade: getGradeFromValue(items[i].no2Value, [0.036, 0.084, 0.12, 0.18, 0.24]),
        so2Grade: getGradeFromValue(items[i].so2Value, [0.03, 0.07, 0.1, 0.15, 0.2]),
        coGrade: getGradeFromValue(items[i].coValue, [5.4, 12.6, 18, 27, 36]),
        o3Grade: getGradeFromValue(items[i].o3Value, [0.054, 0.126, 0.18, 0.27, 0.36]),
        khaiGrade: items[i].khaiGrade,
        pm10Flag: items[i].pm10Flag,
        pm25Flag: items[i].pm25Flag,
        no2Flag: items[i].no2Flag,
        coFlag: items[i].coFlag,
        o3Flag: items[i].o3Flag,
        so2Flag: items[i].so2Flag,
      }
      data.airLevel = findWorstAirQuality(
        data.pm10Grade,
        data.pm25Grade,
        data.no2Grade,
        data.so2Grade,
        data.coGrade,
        data.o3Grade
      )
      const dbRef = db.collection('locations').doc(`${stationName}`);
      await dbRef.set(data);
      console.log(`${stationName} data saved to database successfully.`);
    }
    
  } catch (error) {
    console.error(error);
  }
});
function changeDateFormat(dateStr){
  const date = new Date(dateStr);
  const options = {
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: 'numeric',
    hour12: true
  };

  return date.toLocaleString('en-US', options);
}
function getGradeFromValue(value, breakpoints) {
  if(value == "-" ){
    return "Error"
  }
  const grades = ["Good", "Moderate", "Poor", "Unhealthy", "Very Unhealthy", "Hazardous"]
  if (value <= breakpoints[0]) {
  return grades[0];
  } else if (value <= breakpoints[1]) {
  return grades[1];
  } else if (value <= breakpoints[2]) {
  return grades[2];
  } else if (value <= breakpoints[3]) {
  return grades[3];
  } else if (value <= breakpoints[4]) {
  return grades[4];
  } else {
  return grades[5];
  }
}

function findWorstAirQuality(...args) {
  const airQualityLevels = ["Good", "Moderate", "Poor", "Unhealthy", "Very Unhealthy", "Hazardous"];
  let filteredArgs = args.filter(arg => arg !== "Error");
  if (filteredArgs.length === 0) {
    return "Error";
  }
  let worstAirQuality = filteredArgs[0];
  for (let i = 1; i < filteredArgs.length; i++) {
    if (airQualityLevels.indexOf(filteredArgs[i]) > airQualityLevels.indexOf(worstAirQuality)) {
      worstAirQuality = filteredArgs[i];
    }
  }
  return worstAirQuality;
}


exports.getAirData = functions.region('asia-northeast3').https.onCall(async (data, context) => {
  try {
    const stationName = data.stationName;
    if (!stationName) {
      throw new functions.https.HttpsError('invalid-argument', 'station name 요청');
    }
    const dayArr = [];
    for (let i = 0; i < 6; i++) {
      dayArr.push(moment().add(i+1, 'days').format("YYYY-MM-DD"));
    }
    const [locationDocumentSnapshot, forecastDocumentSnapshot] = await Promise.all([
      admin.firestore().collection('locations').doc(stationName).get(),
      admin.firestore().collection('forecast').doc('forecast').get()
    ]);
    const locationDatas = locationDocumentSnapshot.data();
    const forecastDatas = forecastDocumentSnapshot.data();

    if (!locationDocumentSnapshot.exists||!forecastDocumentSnapshot.exists) {
      throw new functions.https.HttpsError('not-found', 'Document does not exist');
    }
    const sidoName = locationDatas.sidoName;
    if (!sidoName) {
      throw new functions.https.HttpsError('invalid-argument', 'sido name 요청');
    }  
    const items =[];
    const fiveThirtyPmKST = moment().set({hour: 17, minute: 30, second: 0});
    if (moment().isSameOrAfter(fiveThirtyPmKST)) {
      for (let i = 0; i < dayArr.length; i++) {
        const value = {};
        value.day = dayArr[i];
        value.forecastLevel = (forecastDatas[dayArr[i]].value)[sidoName];
        items.push(value);
      }
    } else {
      for (let i = 0; i < dayArr.length-1; i++) {
        const value = {};
        value.day = dayArr[i];
        value.forecastLevel = (forecastDatas[dayArr[i]].value)[sidoName];
        items.push(value);
      }
    }
    const response = {};
    response.forecast = items;
    response.pm10ImgUrl = forecastDatas.PM10ImgUrl;
    response.pm25ImgUrl = forecastDatas.PM25ImgUrl;
    response.thumbnailImageUrl = forecastDatas.thumbnailImageUrl;
    response.information = forecastDatas.information;
    response.airData = locationDatas
    return JSON.stringify(response);
  } catch (error) {
    console.error(error);
    throw error;
  }
});