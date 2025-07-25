// server/src/index.ts

import express from 'express';
import http from 'http';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { Server as WebSocketServer } from 'ws';
import { startMediasoup, getRouter } from './worker';
import { config } from './config';
import { Consumer, Producer, PlainTransport, Transport } from 'mediasoup/types';

// --- State Management ---
interface PeerState {
  transports: Map<string, Transport>;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
}
const peers = new Map<string, PeerState>();
const producers = new Map<string, Producer>();

// --- HLS/FFMPEG State ---
let ffmpegProcess: ChildProcessWithoutNullStreams | null = null;
let rtpTransport: PlainTransport | null = null;
let audioTransport: PlainTransport | null = null; // Separate transport for audio
const rtpConsumers = new Map<string, Consumer>();

// --- Helper Function to Start FFMPEG ---
const startFfmpeg = async () => {
    const router = getRouter();
    
    // Create a PlainTransport for video
    rtpTransport = await router.createPlainTransport(config.mediasoup.plainTransport);
    console.log('[ffmpeg] Mediasoup PlainTransport for video created');
    await rtpTransport.connect({ ip: '127.0.0.1', port: 5004, rtcpPort: 5005 });
    console.log(`[ffmpeg] Video transport connected to ${rtpTransport.tuple.localPort}`);
    
    // Create a separate PlainTransport for audio
    audioTransport = await router.createPlainTransport(config.mediasoup.plainTransport);
    console.log('[ffmpeg] Mediasoup PlainTransport for audio created');
    await audioTransport.connect({ ip: '127.0.0.1', port: 5006, rtcpPort: 5007 });
    console.log(`[ffmpeg] Audio transport connected to ${audioTransport.tuple.localPort}`);

    // Create a directory for HLS files if it doesn't exist
    const hlsDir = path.join(__dirname, '..', '..', 'public', 'hls');
    if (!fs.existsSync(hlsDir)) {
        fs.mkdirSync(hlsDir, { recursive: true });
    }

    // Generate SDP file content dynamically
    const sdpContent = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=FFMPEG
c=IN IP4 127.0.0.1
t=0 0
m=video ${rtpTransport.tuple.localPort} RTP/AVP 101
a=rtpmap:101 VP8/90000
m=audio ${audioTransport.tuple.localPort} RTP/AVP 102
a=rtpmap:102 opus/48000/2`;

    // Write the SDP to a file for FFMPEG to read
    const sdpFilePath = path.join(hlsDir, 'stream.sdp');
    fs.writeFileSync(sdpFilePath, sdpContent);

    const ffmpegArgs = [
        '-protocol_whitelist', 'file,udp,rtp',
        '-i', sdpFilePath,
        '-map', '0:v:0',
        '-map', '1:a:0', // Map the second input (audio)
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-f', 'hls',
        '-hls_time', '1',
        '-hls_list_size', '3',
        '-hls_flags', 'delete_segments+program_date_time',
        path.join(hlsDir, 'stream.m3u8')
    ];

    console.log(`[ffmpeg] Starting FFMPEG with args: ffmpeg ${ffmpegArgs.join(' ')}`);
    ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

    ffmpegProcess.on('error', (err: any) => console.error('[ffmpeg] Error:', err));
    ffmpegProcess.on('exit', (code, signal) => console.log(`[ffmpeg] Process exited with code ${code} and signal ${signal}`));
    ffmpegProcess.stderr.on('data', (data: Buffer) => console.log('[ffmpeg] stderr:', data.toString()));
    ffmpegProcess.stdout.on('data', (data: Buffer) => console.log('[ffmpeg] stdout:', data.toString()));

    console.log('[ffmpeg] FFMPEG process started');

    // Function to pipe a producer to the correct RTP transport (video or audio)
    const pipeProducerToRtp = async (producer: Producer) => {
        const transport = producer.kind === 'video' ? rtpTransport : audioTransport;
        if (!transport) return;

        const rtpConsumer = await transport.consume({
            producerId: producer.id,
            rtpCapabilities: router.rtpCapabilities, // Use router's capabilities for PlainTransport
            paused: false, // Start unpaused
        });
        rtpConsumers.set(producer.id, rtpConsumer);
        console.log(`[ffmpeg] Piped producer ${producer.id} (${producer.kind}) to FFMPEG`);
    };

    // Pipe existing producers to FFMPEG
    for (const producer of producers.values()) {
        await pipeProducerToRtp(producer);
    }
    
    return pipeProducerToRtp; // Return the function to be used for new producers
};


// --- Main Server Function ---
async function run() {
  await startMediasoup();
  const router = getRouter();
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.get('/health', (req, res) => res.send({ status: 'ok' }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  console.log('[server] WebSocket server is running');
  
  let pipeProducerToRtpFunc: ((producer: Producer) => Promise<void>) | null = null;

  wss.on('connection', (socket, req) => {
    const peerId = req.headers['sec-websocket-protocol'] || String(Date.now());
    console.log(`[ws] Peer connected: ${peerId}`);
    
    peers.set(peerId, { transports: new Map(), producers: new Map(), consumers: new Map() });

    if (producers.size > 0) {
        producers.forEach(p => socket.send(JSON.stringify({ event: 'new-producer', data: { producerId: p.id } })));
    }

    socket.on('message', async (message) => {
      try {
        const { id: requestId, event, data } = JSON.parse(message.toString());
        const peerState = peers.get(peerId);
        if (!peerState) throw new Error('Peer state not found');

        const sendResponse = (event: string, data: any) => socket.send(JSON.stringify({ id: requestId, event, data }));

        switch (event) {
          case 'getRouterRtpCapabilities': {
            sendResponse('routerRtpCapabilities', router.rtpCapabilities);
            break;
          }
          case 'createWebRtcTransport': {
            const transport = await router.createWebRtcTransport(config.mediasoup.webRtcTransport);
            peerState.transports.set(transport.id, transport);
            sendResponse('webRtcTransportCreated', {
              id: transport.id,
              iceParameters: transport.iceParameters,
              iceCandidates: transport.iceCandidates,
              dtlsParameters: transport.dtlsParameters,
            });
            break;
          }
          case 'connectWebRtcTransport': {
            const { transportId, dtlsParameters } = data;
            const transport = peerState.transports.get(transportId);
            if (!transport) throw new Error(`Transport not found`);
            await transport.connect({ dtlsParameters });
            sendResponse('transportConnected', { transportId });
            break;
          }
          case 'produce': {
            const { transportId, kind, rtpParameters, appData } = data;
            const transport = peerState.transports.get(transportId);
            if (!transport) throw new Error(`Transport not found`);
            
            const producer = await transport.produce({ kind, rtpParameters, appData });
            peerState.producers.set(producer.id, producer);
            producers.set(producer.id, producer);

            if (!ffmpegProcess) {
                pipeProducerToRtpFunc = await startFfmpeg();
            }
            if (pipeProducerToRtpFunc) {
                await pipeProducerToRtpFunc(producer);
            }

            wss.clients.forEach(client => {
                if (client !== socket) {
                    client.send(JSON.stringify({ event: 'new-producer', data: { producerId: producer.id } }));
                }
            });
            sendResponse('produced', { id: producer.id });
            break;
          }
          case 'consume': {
            const { transportId, producerId, rtpCapabilities } = data;
            const transport = peerState.transports.get(transportId);
            if (!transport) throw new Error(`Transport not found`);
            const producer = producers.get(producerId);
            if (!producer) throw new Error(`Producer not found`);
            if (!router.canConsume({ producerId, rtpCapabilities })) throw new Error('Cannot consume');

            const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
            peerState.consumers.set(consumer.id, consumer);
            consumer.on('transportclose', () => socket.send(JSON.stringify({ event: 'consumer-closed', data: { consumerId: consumer.id }})));
            consumer.on('producerclose', () => socket.send(JSON.stringify({ event: 'consumer-closed', data: { consumerId: consumer.id }})));
            sendResponse('consumed', { id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
            break;
          }
          case 'resume-consumer': {
              const { consumerId } = data;
              const consumer = peerState.consumers.get(consumerId);
              if (!consumer) throw new Error(`Consumer not found`);
              await consumer.resume();
              sendResponse('consumer-resumed', { consumerId });
              break;
          }
        }
      } catch (err) {
        console.error(`[ws] Error handling message from ${peerId}:`, err);
      }
    });

    socket.on('close', () => {
      console.log(`[ws] Peer disconnected: ${peerId}`);
      const peerState = peers.get(peerId);
      if (peerState) {
          peerState.producers.forEach(producer => {
              producers.delete(producer.id);
              rtpConsumers.get(producer.id)?.close();
              rtpConsumers.delete(producer.id);
          });
          peerState.transports.forEach(transport => transport.close());
          peers.delete(peerId);
      }
      if (producers.size === 0 && ffmpegProcess) {
          console.log('[ffmpeg] All producers left, stopping FFMPEG');
          ffmpegProcess.kill('SIGINT');
          ffmpegProcess = null;
          rtpTransport?.close();
          rtpTransport = null;
          audioTransport?.close();
          audioTransport = null;
          pipeProducerToRtpFunc = null;
      }
    });
  });

  server.listen(config.listenPort, config.listenIp, () => {
    console.log(`[server] Server is listening on http://${config.listenIp}:${config.listenPort}`);
  });
}

run();
