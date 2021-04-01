const mediasoup = require('mediasoup');
const fs = require('fs');
const https = require('https');
const express = require('express');
const socketIO = require('socket.io');
const config = require('./config');
const interactiveServer = require('./lib/interactiveServer');
const interactiveClient = require('./lib/interactiveClient');

// Global variables
let worker;
let webServer;
let socketServer;
let expressApp;
let producer;
let producerTransport;
let mediasoupRouter;
let producerRouter = null;
let consumerRouter = null;

function dumpObj(msg, obj){
  console.log(msg, JSON.stringify(obj, "", 2));
}

(async () => {
  try {
    // Open the interactive server.
    await interactiveServer();

    // Open the interactive client.
    if (process.env.INTERACTIVE === 'true' || process.env.INTERACTIVE === '1')
      await interactiveClient();

    runExpressApp();
    await runWebServer();
    runSocketServer();
    await runMediasoupRoom();
    // await runMediasoupWorker();
  } catch (err) {
    console.error(err);
  }
})();

function runExpressApp() {
  expressApp = express();
  expressApp.use(express.json());
  expressApp.use(express.static(__dirname));

  expressApp.use((error, req, res, next) => {
    if (error) {
      console.warn('Express app error,', error.message);
      error.status = error.status || (error.name === 'TypeError' ? 400 : 500);
      res.statusMessage = error.message;
      res.status(error.status).send(String(error));
    } else {
      next();
    }
  });
}

async function runWebServer() {
  const { sslKey, sslCrt } = config;
  if (!fs.existsSync(sslKey) || !fs.existsSync(sslCrt)) {
    console.error('SSL files are not found. check your config.js file');
    process.exit(0);
  }
  const tls = {
    cert: fs.readFileSync(sslCrt),
    key: fs.readFileSync(sslKey),
  };
  webServer = https.createServer(tls, expressApp);
  webServer.on('error', (err) => {
    console.error('starting web server failed:', err.message);
  });

  await new Promise((resolve) => {
    const { listenIp, listenPort } = config;
    webServer.listen(listenPort, listenIp, () => {
      const listenIps = config.mediasoup.webRtcTransport.listenIps[0];
      const ip = listenIps.announcedIp || listenIps.ip;
      console.log('server is running');
      console.log(`open https://${ip}:${listenPort} in your web browser`);
      resolve();
    });
  });
}

function runSocketServer() {
  socketServer = socketIO(webServer, {
    serveClient: false,
    path: '/server',
    log: false,
  });

  socketServer.on('connection', (socket) => {
    console.log('client connected');
    let consumer;
    let consumerTransport;    
    // inform the client about existence of producer
    if (producer) {
      socket.emit('newProducer', producer.id);
    }

    function closeConsumer(){
      if(consumer){
        consumer.close();
        consumer = null;
      }
      if(consumerTransport){
        consumerTransport.close();
        consumerTransport = null;
      }
    }

    socket.on('disconnect', () => {
      console.log('client disconnected');
      closeConsumer();
    });

    socket.on('connect_error', (err) => {
      console.error('client connection error', err);
    });

    socket.on('getRouterRtpCapabilities', (data, callback) => {
      callback(mediasoupRouter.rtpCapabilities);
    });

    socket.on('createProducerTransport', async (data, callback) => {
      try {
        const { transport, params } = await createWebRtcTransport(producerRouter||mediasoupRouter);
        producerTransport = transport;
        dumpObj("createProducerTransport return ", params);
        callback(params);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    socket.on('createConsumerTransport', async (data, callback) => {
      try {
        const { transport, params } = await createWebRtcTransport(consumerRouter||mediasoupRouter);
        consumerTransport = transport;
        dumpObj("createConsumerTransport return ", params);
        callback(params);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    socket.on('connectProducerTransport', async (data, callback) => {
      dumpObj("connectProducerTransport with ", data);
      await producerTransport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    });

    socket.on('connectConsumerTransport', async (data, callback) => {
      dumpObj("connectConsumerTransport with ", data);
      await consumerTransport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    });

    socket.on('produce', async (data, callback) => {
      const {kind, rtpParameters} = data;
      producer = await producerTransport.produce({ kind, rtpParameters });
      if(consumerRouter){
        await producerRouter.pipeToRouter({
          producerId : producer.id,
          router     : consumerRouter
        });  
      }
      
      dumpObj('produce with', data);
      dumpObj("return " + producer.id + " consumableRtpParameters=", producer.consumableRtpParameters);
      callback({ id: producer.id });
      // inform clients about new producer
      socket.broadcast.emit('newProducer', producer.id);
    });

    async function createConsumer(producerId, rtpCapabilities) {
      let router = producerRouter||mediasoupRouter;
      /* 
      if (!router.canConsume(
        {
          producerId: producer.id,
          rtpCapabilities,
        })
      ) {
        console.error('can not consume');
        return;
      }
      */
      try {
        let producer = await router.loadProducer(producerId);
        consumer = await consumerTransport.consume({
          producerId,
          rtpCapabilities,
          paused: producer.kind === 'video',
        });
      } catch (error) {
        console.error('consume failed', error);
        return;
      }
    
      if (consumer.type === 'simulcast') {
        await consumer.setPreferredLayers({ spatialLayer: 2, temporalLayer: 2 });
      }
      return {
        producerId,
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused
      };
    }

    socket.on('consume', async (data, callback) => {
      dumpObj('consume with ', data);
      ret = await createConsumer(data.producerId, data.rtpCapabilities);
      dumpObj('consume return', ret);
      callback(ret);
    });

    socket.on('resume', async (data, callback) => {
      dumpObj('resume', data);
      if(consumer)
        await consumer.resume();
      callback();
    });
    socket.on('unsubscribe', async (data, callback) => {
      console.log('unsubscribe');
      closeConsumer();
      callback();
    });
  });
}
async function runMediasoupRoom() {
  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  dumpObj("createRoom use mediaCodecs", mediaCodecs);
  await mediasoup.initRoom({ mediaCodecs, 
    // io : socketServer,
    redis : config.mediasoup.redis,
    port: config.mediasoup.worker.rtcMinPort,
    webrtc: config.mediasoup.webRtcTransport,
    zone: 'jiuqu'
   });
   mediasoupRouter = await mediasoup.createRoom("9797");
   dumpObj("createRoom return rtpCapabilities", mediasoupRouter.rtpCapabilities);
}

async function runMediasoupWorker() {
  worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on('died', () => {
    console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
    setTimeout(() => process.exit(1), 2000);
  });
  worker.sharePort({stun_server: {ip:"120.26.218.183", port:3478}, listenIp: config.mediasoup.webRtcTransport.listenIps[0]});
  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  dumpObj("createRouter use mediaCodecs", mediaCodecs);
  mediasoupRouter = await worker.createRouter({ mediaCodecs });
  // producerRouter = await worker.createRouter({ mediaCodecs });
  // consumerRouter = await worker.createRouter({ mediaCodecs });
  dumpObj("createRouter return rtpCapabilities", mediasoupRouter.rtpCapabilities);
}

async function createWebRtcTransport(route) {
  const {
    maxIncomingBitrate,
    initialAvailableOutgoingBitrate
  } = config.mediasoup.webRtcTransport;

  const transport = await route.createWebRtcTransport({
    listenIps: config.mediasoup.webRtcTransport.listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    sharePort: true,
    initialAvailableOutgoingBitrate,
  });
  if (maxIncomingBitrate) {
    try {
      await transport.setMaxIncomingBitrate(maxIncomingBitrate);
    } catch (error) {
    }
  }
  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    },
  };
}

