import { Device, Transport, Producer, Consumer, RtpCapabilities, ProducerOptions, TransportOptions } from './types';
import { connect, Socket } from 'socket.io-client';

import { Logger } from './Logger';
const logger = new Logger('RoomClient');

const PC_PROPRIETARY_CONSTRAINTS =
{
  optional: [{ googDscp: true }]
};

const VIDEO_SIMULCAST_ENCODINGS =
  [
    { scaleResolutionDownBy: 4, maxBitRate: 100000 },
    { scaleResolutionDownBy: 1, maxBitRate: 1200000 }
  ];

// Used for VP9 webcam video.
const VIDEO_KSVC_ENCODINGS =
  [
    { scalabilityMode: 'S3T3_KEY' }
  ];

// Used for VP9 desktop sharing.
const VIDEO_SVC_ENCODINGS =
  [
    { scalabilityMode: 'S3T3', dtx: true }
  ];

export class RoomClient {
  socket: Socket;
  device?: Device;

  sendTransport?: Transport;
  recvTransport?: Transport;
  _producers: Map<string, Producer> = new Map();
  _consumers: Map<string, Consumer> = new Map();

  _turnServers: RTCIceServer[] = [];
  peerId: String;
  displayName: String;
  forceTcp: boolean = false;

  close() {
    if (this.sendTransport) {
      this.sendTransport.close();
      this.sendTransport = undefined;
    }
    if (this.recvTransport) {
      this.recvTransport.close();
      this.recvTransport = undefined;
    }
    this.socket.close();
  }

  constructor(
    peerId: string,
    displayName: string,
    forceTcp: boolean,
    muted: boolean) 
  {
    this.displayName = displayName;
    this.peerId = peerId;
    this.forceTcp = forceTcp;

    const opts = {
      path: '/server',
      transports: ['websocket'],
    };
    const serverUrl = `https://127.0.0.1:3000`;
    let socket = connect(serverUrl, opts);
    socket.on('connect', async () => {
    });

    socket.on('disconnect', () => {
      this.close();
    });

    socket.on('connect_error', (error : any) => {
      console.error('could not connect to %s%s (%s)', serverUrl, opts.path, error.message);
    });

    socket.on('notification', async (notification : {method:string, data:any}) => {
      logger.debug('socket "notification" event [method:"%s", data:"%o"]', notification.method, notification.data);
      try {
        switch (notification.method) {
          case 'changeDisplayName':
            {
              const { peerId, displayName, oldDisplayName } = notification.data;
              // store.dispatch(peerActions.setPeerDisplayName(displayName, peerId));
              break;
            }
          case 'msg':
            {
              const { peerId, chatMessage } = notification.data;
              // store.dispatch(chatActions.addResponseMessage({ ...chatMessage, peerId }));
              break;
            }
          case 'producerScore':
            {
              const { producerId, score } = notification.data;
              //store.dispatch(producerActions.setProducerScore(producerId, score));
              break;
            }

          case 'newPeer':
            {
              const { id, displayName, picture, roles, producers } = notification.data;
              // store.dispatch(peerActions.addPeer({ id, displayName, picture, roles, consumers: [] }));
              for(const producer of producers){
                this.consume(producer.id);
              }
              break;
            }
          case 'newProducer':
            {
              const {peerId, producerId} = notification.data;
              this.consume(producerId);
              break;
            }
          case 'peerClosed':
            {
              const { peerId } = notification.data;
              //this._spotlights.closePeer(peerId);
              //store.dispatch(peerActions.removePeer(peerId));
              break;
            }

          case 'consumerClosed':
            {
              const { consumerId } = notification.data;
              const consumer = this._consumers.get(consumerId);
              if (!consumer)
                break;

              consumer.close();
              /* 
              if (consumer.hark != null)
                consumer.hark.stop();
              */
              this._consumers.delete(consumerId);
              const { peerId } = consumer.appData;
              break;
            }

          case 'consumerPaused':
            {
              const { consumerId } = notification.data;
              const consumer = this._consumers.get(consumerId);
              if (!consumer)
                break;

              //store.dispatch(consumerActions.setConsumerPaused(consumerId, 'remote'));
              break;
            }
          case 'consumerResumed':
            {
              const { consumerId } = notification.data;
              const consumer = this._consumers.get(consumerId);
              if (!consumer)
                break;

              // store.dispatch(consumerActions.setConsumerResumed(consumerId, 'remote'));
              break;
            }
          case 'consumerLayersChanged':
            {
              const { consumerId, spatialLayer, temporalLayer } = notification.data;
              const consumer = this._consumers.get(consumerId);
              if (!consumer)
                break;

              // store.dispatch(consumerActions.setConsumerCurrentLayers(consumerId, spatialLayer, temporalLayer));
              break;
            }
          case 'consumerScore':
            {
              const { consumerId, score } = notification.data;
              // store.dispatch(consumerActions.setConsumerScore(consumerId, score));
              break;
            }

          case 'moderator:kick':
            {
              // Need some feedback
              this.close();
              break;
            }
          default:
            {
              logger.error('unknown notification.method "%s"', notification.method);
            }
        }
      }
      catch (error) {
        logger.error('error on socket "notification" event [error:"%o"]', error);
      }
    });
    this.socket = socket;
  }

	_timeoutCallback(callback:any)
	{
		let called = false;

		const interval = setTimeout(
			() =>
			{
				if (called)
					return;
				called = true;
				callback(new Error('Request timed out'));
			},
			config.requestTimeout || 20000
		);

		return (...args) =>
		{
			if (called)
				return;
			called = true;
			clearTimeout(interval);

			callback(...args);
		};
	}

	async request(method:string, data = {}): Promise<any> {
		return new Promise((resolve, reject) =>
		{
			this.socket.emit(
				'request',
				{ method, data },
				this._timeoutCallback((err : any, response: any) =>
				{
					if (err)
					{
						reject(err);
					}
					else
					{
						resolve(response);
					}
				})
			);
		});
	}

  async join(displayName: string) {
    if(!this.device)
    {
      let routerRtpCapabilities = await this.request('getRouterRtpCapabilities') as RtpCapabilities;
      routerRtpCapabilities.headerExtensions = routerRtpCapabilities.headerExtensions!
        .filter((ext) => ext.uri !== 'urn:3gpp:video-orientation');

      this.device = new Device();
      await this.device.load({ routerRtpCapabilities });
    }

    let resp = await this.request('join',
      {
        displayName,
        rtpCapabilities: this.device.rtpCapabilities
      });
    this.sendTransport = await this.createTransport(true);
    this.recvTransport = await this.createTransport(false);
  }

  async createTransport(producing = true, forceTcp = false): Promise<Transport | undefined> {
    if(!this.device) return undefined;

    const transportInfo = await this.request(
      'createWebRtcTransport',
      {
        forceTcp,
        producing,
      });

    const {
      id,
      iceParameters,
      iceCandidates,
      dtlsParameters
    } = transportInfo;

    let tansportOpt = {
      id,
      iceParameters,
      iceCandidates,
      dtlsParameters,
      iceServers: this._turnServers,
      // TODO: Fix for issue #72
      // iceTransportPolicy     : this.device.flag === 'firefox' && this._turnServers ? 'relay' : undefined,
      proprietaryConstraints: PC_PROPRIETARY_CONSTRAINTS
    } as TransportOptions;

    let transport;
    if (producing) {
      transport = this.device.createSendTransport(tansportOpt);
      transport.on(
        'produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
        // this callback with producerId {id}
        this.request('produce',
          {
            transportId: id,
            kind,
            rtpParameters,
            appData
          }).then(callback).catch(errback);
      });
    }
    else {
      transport = this.device.createRecvTransport(tansportOpt);
    }

    transport.on(
      'connect', ({ dtlsParameters }, callback, errback) => {
      this.request(
        'connectWebRtcTransport',
        {
          transportId: id,
          dtlsParameters
        })
        .then(callback)
        .catch(errback);
    });
    return transport;
  }

  async produceMic(){
    let stream = await navigator.mediaDevices.getUserMedia({
      audio: true /* applyConstraints {
        deviceId : { ideal: deviceId },
        sampleRate,
        channelCount,
        volume,
        autoGainControl,
        echoCancellation,
        noiseSuppression,
        sampleSize
      }*/,
      video: true/*{
        deviceId : { ideal: deviceId },
        ...VIDEO_CONSTRAINS[resolution],
        frameRate
      }*/
    });
    let [track] = stream.getTracks();
    return this.produce(track);
  }

  async produce(track: MediaStreamTrack, simulcast = false): Promise<Producer|undefined> {
    if(!this.sendTransport || !this.device) 
      return undefined;

    let params = { track } as ProducerOptions;
    if (track.kind == 'audio') {
      /*
      params.codecOptions =
      {
        opusStereo,
        opusDtx,
        opusFec,
        opusPtime,
        opusMaxPlaybackRate
      }; */
      params.appData = { source: 'mic' };
    }
    else {
      params.appData = { source: 'video' };
      if (simulcast) {
        // If VP9 is the only available video codec then use SVC.
        const firstVideoCodec = this.device.rtpCapabilities
          .codecs!.find((c) => c.kind === 'video');
        if (firstVideoCodec && firstVideoCodec.mimeType.toLowerCase() === 'video/vp9')
          params.encodings = VIDEO_KSVC_ENCODINGS;
        else
          params.encodings = VIDEO_SIMULCAST_ENCODINGS;
        /*
        params.encodings = [
          { maxBitrate: 100000 },
          { maxBitrate: 300000 },
          { maxBitrate: 900000 },
        ];
        */
        params.codecOptions = {
          videoGoogleStartBitrate: 1000
        };
      }
    }

    let producer = await this.sendTransport.produce(params);
    this._producers.set(producer.id, producer);
    producer.on('transportclose', () => {
      this._producers.delete(producer.id);
    });

    producer.on('trackended', () => {
      this.closeProducer(producer.id);
    });
    return producer;
  }

  async closeProducer(producerId: string): Promise<void> {
    let producer = this._producers.get(producerId);
    if (!producer || producer.closed)
      return;

    try {
      producer.close();
      await this.request('closeProducer', { producerId });
    }
    catch (error) {
      logger.error('closeProducer() [error:"%o"]', error);
    }
  }

  async pauseProducer(producerId: string) {
    logger.debug('pauseProducer(%s)', producerId);
    let producer = this._producers.get(producerId);
    if (!producer || producer.paused || producer.closed)
      return;

    try {
      producer.pause();
      await this.request('pauseProducer', { producerId });
    }
    catch (error) {
      logger.error('pauseProducer(%s) [error:"%o"]', producerId, error);
    }
  }

  async resumeProducer(producerId: string) {
    logger.debug('resumeProducer(%s)', producerId);
    let producer = this._producers.get(producerId);
    if (!producer || !producer.paused || producer.closed)
      return;

    try {
      producer.resume();
      await this.request('resumeProducer', { producerId });
    }
    catch (error) {
      logger.error('resumeProducer(%s) [error:"%o"]', producerId, error);
    }
  }

  async consume(producerId: string) : Promise<Consumer|undefined>{
    if(!this.recvTransport) return;
    let data = null;
    try{
      data = await this.request('consume', { producerId });
    }
    catch(err){
      logger.error('consume error', err);
      return undefined;
    }
    const {
      peerId,
      id,
      kind,
      rtpParameters,
      type,
      appData,
      producerPaused
    } = data;

    const consumer = await this.recvTransport.consume({
      id,
      producerId,
      kind,
      rtpParameters,
      appData: { ...appData, peerId } // Trick.
    });

    // Store in the map.
    this._consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => {
      this._consumers.delete(consumer.id);
    });

    // We are ready. Answer the request so the server will
    // resume this Consumer (which was paused for now).
    this.request('resumeConsumer', { consumerId: consumer.id });
    /* 
    if (kind === 'audio')
    {
      consumer.volume = 0;

      const stream = new MediaStream();
      stream.addTrack(consumer.track);
      if (!stream.getAudioTracks()[0])
        throw new Error('request.newConsumer | given stream has no audio track');
      consumer.hark = hark(stream, { play: false });
      consumer.hark.on('volume_change', (volume) =>
      {
        volume = Math.round(volume);
        if (consumer && volume !== consumer.volume)
        {
          consumer.volume = volume;
          store.dispatch(peerVolumeActions.setPeerVolume(peerId, volume));
        }
      });
    }
    */
   return consumer;
  }

  async closeConsumer(consumerId: string) {
    let consumer = this._consumers.get(consumerId);
    if (!consumer || consumer.closed)
      return;

    try {
      await this.request('closeConsumer', { consumerId });
      consumer.close();
    }
    catch (error) {
      logger.error('closeConsumer() [error:"%o"]', error);
    }
  }

  async pauseConsumer(consumerId: string) {
    logger.debug('pauseConsumer(%s)', consumerId);
    let consumer = this._consumers.get(consumerId);
    if (!consumer || consumer.paused || consumer.closed)
      return;

    try {
      await this.request('pauseConsumer', { consumerId });
      consumer.pause();
    }
    catch (error) {
      logger.error('pauseConsumer() [error:"%o"]', error);
    }
  }

  async resumeConsumer(consumerId: string) {
    logger.debug('resumeConsumer(%s)', consumerId);
    let consumer = this._consumers.get(consumerId);
    if (!consumer || !consumer.paused || consumer.closed)
      return;

    try {
      await this.request('resumeConsumer', { consumerId });
      consumer.resume();
    }
    catch (error) {
      logger.error('resumeConsumer() [error:"%o"]', error);
    }
  }

  async setConsumerPreferredLayers(consumerId : string, spatialLayer : number, temporalLayer: number) {
    logger.debug('setConsumerPreferredLayers(consumerId:"%s", spatialLayer:"%s", temporalLayer:"%s")',
      consumerId, spatialLayer, temporalLayer);
    try {
      await this.request(
        'setConsumerPreferedLayers', { consumerId, spatialLayer, temporalLayer });
    }
    catch (error) {
      logger.error('setConsumerPreferredLayers() [error:"%o"]', error);
    }
  }

  async setConsumerPriority(consumerId : string, priority: number) {
    logger.debug('setConsumerPriority(consumerId:"%s", priority:%d)', consumerId, priority);
    try {
      await this.request('setConsumerPriority', { consumerId, priority });
    }
    catch (error) {
      logger.error('setConsumerPriority() [error:"%o"]', error);
    }
  }

  async requestConsumerKeyFrame(consumerId : string) {
    logger.debug('requestConsumerKeyFrame(%s)', consumerId);
    try {
      await this.request('requestConsumerKeyFrame', { consumerId });
    }
    catch (error) {
      logger.error('requestConsumerKeyFrame() [error:"%o"]', error);
    }
  }

}