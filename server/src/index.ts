import express from 'express';
import cors from 'cors';
import http from 'http';
import https from 'https';
import fs from 'fs';
import { WebSocketServer } from 'ws';
import { startMediaSoup, getRouter, getWebRtcServer } from './worker';
import { config } from './config';
import { Producer, Transport, Consumer } from 'mediasoup/types';

interface PeerState {
    peerId: string;
    transports: Map<string, Transport>;
    producers: Map<string, Producer>;
    consumers: Map<string, Consumer>;
}

const peers = new Map<string, PeerState>();
const producers = new Map<string, Producer>();

async function run() {
    await startMediaSoup();
    const router = getRouter();
    const webRtcServer = getWebRtcServer();

    const app = express();
    app.use(cors());
    app.use(express.json());

    app.get('/health', (req, res) => {
        res.send({ status: 'ok' });
    })

    const key = fs.readFileSync('./localhost+1-key.pem');
    const cert = fs.readFileSync('./localhost+1.pem');
    const server = https.createServer({ key, cert }, app);
    const wss = new WebSocketServer({ server });
    console.log(`[server] web socket server is running`);

    wss.on('connection', (socket, req) => {
        // Get peerId from the Sec-WebSocket-Protocol header or generate one
        const peerId = (Array.isArray(req.headers['sec-websocket-protocol']) 
            ? req.headers['sec-websocket-protocol'][0] 
            : req.headers['sec-websocket-protocol']) || `peer_${Date.now()}_${Math.random()}`;
        
        console.log(`[ws] Peer connected: ${peerId}`);

        const peerState: PeerState = {
            peerId,
            transports: new Map(),
            producers: new Map(),
            consumers: new Map()
        };
        
        peers.set(peerId, peerState);

        // Send existing producers to the newly connected peer
        console.log(`[ws] Sending ${producers.size} existing producers to new peer ${peerId}`);
        producers.forEach(producer => {
            const producerPeerId = findProducerPeer(producer.id);
            // Don't send own producers back
            if (producerPeerId !== peerId) {
                console.log(`[ws] Sending existing producer ${producer.id} to ${peerId}`);
                socket.send(JSON.stringify({ 
                    event: 'new-producer', 
                    data: { producerId: producer.id } 
                }));
            }
        });

        socket.on('message', async (message) => {
            try {
                const { event, data, requestId } = JSON.parse(message.toString());
                console.log(`[ws] Received event: ${event} from ${peerId}`, data);
                
                const peerState = peers.get(peerId);
                if (!peerState && event !== 'getRouterRtpCapabilities') {
                    throw new Error('Peer state not found');
                }

                const send = <T>(event: string, data: T) => {
                    const response = { event, data, requestId };
                    console.log(`[ws] Sending response to ${peerId}:`, response);
                    socket.send(JSON.stringify(response));
                };

                switch (event) {
                    case 'getRouterRtpCapabilities': {
                        console.log(`[ws] Sending router RTP capabilities to ${peerId}`);
                        send('routerRtpCapabilities', router.rtpCapabilities);
                        break;
                    }
                    case 'createWebRtcTransport': {
                        console.log(`[ws] Creating WebRTC transport for ${peerId}`);
                        const transport = await router.createWebRtcTransport({
                            ...config.mediasoup.webRtcTransport,
                            webRtcServer: webRtcServer
                        });
                        peerState?.transports.set(transport.id, transport);
                        
                        transport.on('dtlsstatechange', (dtlsState) => {
                            console.log(`[ws] Transport ${transport.id} DTLS state: ${dtlsState}`);
                        });

                        send('createWebRtcTransport', {
                            id: transport.id,
                            iceParameters: transport.iceParameters,
                            iceCandidates: transport.iceCandidates,
                            dtlsParameters: transport.dtlsParameters
                        });
                        break;
                    }
                    case 'connectWebRtcTransport': {
                        const { transportId, dtlsParameters } = data;
                        console.log(`[ws] Connecting transport ${transportId} for ${peerId}`);
                        const transport = peerState?.transports.get(transportId);
                        if (!transport) {
                            throw new Error(`Transport with id "${transportId}" not found`);
                        }
                        await transport.connect({ dtlsParameters });
                        console.log(`[ws] Transport ${transportId} connected for ${peerId}`);
                        send('connectWebRtcTransport', { transportId });
                        break;
                    }
                    case 'produce': {
                        const { transportId, kind, rtpParameters, appData } = data;
                        console.log(`[ws] Producing ${kind} for ${peerId} on transport ${transportId}`);
                        const transport = peerState?.transports.get(transportId);
                        if (!transport) {
                            throw new Error(`Transport with id "${transportId}" not found`);
                        }
                        const producer = await transport.produce({ kind, rtpParameters, appData });
                        peerState?.producers.set(producer.id, producer);
                        producers.set(producer.id, producer);

                        console.log(`[ws] Producer ${producer.id} created for peer ${peerId}, broadcasting to ${wss.clients.size - 1} other clients`);

                        // Broadcast to OTHER clients only (exclude the sender)
                        let broadcastCount = 0;
                        wss.clients.forEach(client => {
                            if (client !== socket && client.readyState === WebSocket.OPEN) {
                                console.log(`[ws] Broadcasting new producer ${producer.id} to another client`);
                                client.send(JSON.stringify({ 
                                    event: 'new-producer', 
                                    data: { producerId: producer.id } 
                                }));
                                broadcastCount++;
                            }
                        });
                        
                        console.log(`[ws] Broadcasted to ${broadcastCount} clients`);
                        send('produce', { id: producer.id });
                        break;
                    }
                    case 'consume': {
                        const { transportId, producerId, rtpCapabilities } = data;
                        console.log(`[ws] Consumer request: ${peerId} wants to consume ${producerId}`);
                        const transport = peerState?.transports.get(transportId);
                        if (!transport) {
                            throw new Error(`Transport with id "${transportId}" not found`);
                        }
                        const producer = producers.get(producerId);
                        if (!producer) {
                            throw new Error(`Producer with id "${producerId}" not found`);
                        }

                        // Check if peer is trying to consume their own producer
                        const producerPeerId = findProducerPeer(producerId);
                        if (producerPeerId === peerId) {
                            console.log(`[ws] Peer ${peerId} trying to consume own producer ${producerId}, skipping`);
                            return;
                        }

                        if (!router.canConsume({ producerId, rtpCapabilities })) {
                            throw new Error(`Cannot consume producer ${producerId}`);
                        }

                        const consumer = await transport.consume({
                            producerId,
                            rtpCapabilities,
                            paused: true,
                        });

                        peerState?.consumers.set(consumer.id, consumer);

                        consumer.on('transportclose', () => {
                            console.log(`[ws] Consumer's transport closed: ${consumer.id}`);
                            socket.send(JSON.stringify({ event: "consumer-closed", data: { consumerId: consumer.id } }));
                        });
                        consumer.on('producerclose', () => {
                            console.log(`[ws] Consumer's producer closed: ${consumer.id}`);
                            socket.send(JSON.stringify({ event: "consumer-closed", data: { consumerId: consumer.id } }));
                        });

                        console.log(`[ws] Consumer ${consumer.id} created for ${peerId} to consume ${producerId}`);
                        send('consume', {
                            id: consumer.id,
                            producerId: consumer.producerId,
                            kind: consumer.kind,
                            rtpParameters: consumer.rtpParameters,
                        });
                        break;
                    }
                    case 'resume-consumer': {
                        const { consumerId } = data;
                        console.log(`[ws] Resuming consumer ${consumerId} for ${peerId}`);
                        const consumer = peerState?.consumers.get(consumerId);
                        if (!consumer) throw new Error(`Consumer with id "${consumerId}" not found`);
                        await consumer.resume();
                        console.log(`[ws] Consumer ${consumerId} resumed for ${peerId}`);
                        send('resume-consumer', { consumerId });
                        break;
                    }
                    default:
                        console.log(`[ws] Unknown event: ${event}`);
                        break;
                }
            } catch (err) {
                console.error(`[ws] Error handling message from ${peerId}:`, err);
                socket.send(JSON.stringify({ 
                    event: 'error', 
                    data: (err as Error).message,
                    requestId: JSON.parse(message.toString()).requestId
                }));
            }
        });

        socket.on('close', () => {
            console.log(`[ws] Peer disconnected: ${peerId}`);
            
            // Clean up peer's producers from global map
            peerState.producers.forEach(producer => {
                console.log(`[ws] Removing producer ${producer.id} from global map`);
                producers.delete(producer.id);
                producer.close();
            });
            
            // Close all transports
            peerState.transports.forEach(transport => {
                console.log(`[ws] Closing transport ${transport.id}`);
                transport.close();
            });
            
            peers.delete(peerId);
            console.log(`[ws] Cleanup completed for ${peerId}`);
        });

        socket.on('error', (error) => {
            console.error(`[ws] Socket error for ${peerId}:`, error);
        });
    });

    // Helper function to find which peer owns a producer
    function findProducerPeer(producerId: string): string | undefined {
        for (const [peerId, peerState] of peers.entries()) {
            if (peerState.producers.has(producerId)) {
                return peerId;
            }
        }
        return undefined;
    }

    server.listen(config.listenPort, config.listenIp, () => {
        console.log(`[server]: server is listening on at https://${config.listenIp}:${config.listenPort}`);
    });
}

run();