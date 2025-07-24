import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { startMediaSoup, getRouter, getWebRtcServer } from './worker';
import { config } from './config';
import { Producer, Transport, Consumer } from 'mediasoup/types';

interface PeerState {
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

    const server = http.createServer(app);
    const wss = new WebSocketServer({ server });
    console.log(`[server] web socket server is running`);

    wss.on('connection', (socket, req) => {
        const peerId = req.headers['sec-websocket-protocol'] || String(Date.now());
        console.log(`[ws] Peer connected : ${peerId}`);

        peers.set(peerId, {
            transports: new Map(),
            producers: new Map(),
            consumers: new Map()
        });

        // Send existing producers to the newly connected peer
        producers.forEach(producer => {
            socket.send(JSON.stringify({ event: 'new-producer', data: { producerId: producer.id } }));
        });

        socket.on('message', async (message) => {
            try {
                const { event, data, requestId } = JSON.parse(message.toString());
                console.log(`[ws] Received event : ${event} from ${peerId}`);
                const peerState = peers.get(peerId);
                if (!peerState && event !== 'getRouterRtpCapabilities') {
                    throw new Error('Peer state not found');
                }

                const send = <T>(event: string, data: T) => {
                    socket.send(JSON.stringify({ event, data, requestId }));
                };

                switch (event) {
                    case 'getRouterRtpCapabilities': {
                        const capabilities = router.rtpCapabilities;
                        send('routerRtpCapabilities', router.rtpCapabilities);
                        break;
                    }
                    case 'createWebRtcTransport': {
                        const transport = await router.createWebRtcTransport({
                            ...config.mediasoup.webRtcTransport,
                            webRtcServer: webRtcServer
                        });
                        peerState?.transports.set(transport.id, transport);
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
                        const transport = peerState?.transports.get(transportId);
                        if (!transport) {
                            throw new Error(`Transport with id "${transportId}" not found`);
                        }
                        await transport.connect({ dtlsParameters });
                        send('connectWebRtcTransport', { transportId });
                        break;
                    }
                    case 'produce': {
                        const { transportId, kind, rtpParameters, appData } = data;
                        const transport = peerState?.transports.get(transportId);
                        if (!transport) {
                            throw new Error(`Transport with id "${transportId}" not found`);
                        }
                        const producer = await transport.produce({ kind, rtpParameters, appData });
                        peerState?.producers.set(producer.id, producer);
                        producers.set(producer.id, producer);

                        wss.clients.forEach(client => {
                            client.send(JSON.stringify({ event: 'new-producer', data: { producerId: producer.id } }));
                        });

                        send('produce', { id: producer.id });
                        break;
                    }
                    case 'consume': {
                        const { transportId, producerId, rtpCapabilities } = data;
                        const transport = peerState?.transports.get(transportId);
                        if (!transport) {
                            throw new Error(`Transport with id "${transportId}" not found`);
                        }
                        const producer = producers.get(producerId);
                        if (!producer) {
                            throw new Error(`Producer with id "${producerId}" not found`);
                        }

                        if (!router.canConsume({ producerId, rtpCapabilities })) {
                            throw new Error(`Cannot consume this producer`);
                        }

                        const consumer = await transport.consume({
                            producerId,
                            rtpCapabilities,
                            paused: true,
                        });

                        peerState?.consumers.set(consumer.id, consumer);

                        consumer.on('transportclose', () => {
                            console.log(`[ws] Consumer's transport closed : ${consumer.id}`);
                            socket.send(JSON.stringify({ event: "consumer-closed", data: { consumerId: consumer.id } }));
                        });
                        consumer.on('producerclose', () => {
                            console.log(`[ws] Consumer's producer closed: ${consumer.id}`);
                            socket.send(JSON.stringify({ event: "consumer-closed", data: { consumerId: consumer.id } }));
                        });

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
                        const consumer = peerState?.consumers.get(consumerId);
                        if (!consumer) throw new Error(`Consumer with id "${consumerId}" not found`);
                        await consumer.resume();
                        send('resume-consumer', { consumerId });
                        break;
                    }
                }
            } catch (err) {
                console.error(`[ws] Error handling message from ${peerId}: `, err);
                socket.send(JSON.stringify({ event: 'error', data: (err as Error).message }));
            }
        });

        socket.on('close', () => {
            console.log(`[ws] peer disconnected : ${peerId}`);
            //cleanup
            peers.get(peerId)?.transports.forEach(transport => transport.close());
            peers.get(peerId)?.producers.forEach(producer => producers.delete(producer.id));
            peers.delete(peerId);
        });
    });

    server.listen(config.listenPort, config.listenIp, () => {
        console.log(`[server]: server is listening on at http://${config.listenIp}:${config.listenPort}`);
    });
}

run();