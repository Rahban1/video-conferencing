'use client'

import { useEffect, useRef, useState } from "react";
import * as mediasoupClient from 'mediasoup-client';
import { Consumer, Producer, Transport, RtpCapabilities } from "mediasoup-client/types";

const SERVER_URL = 'ws://localhost:3001';

interface RemoteStream {
    id: string;
    producerId: string;
    stream: MediaStream;
    kind: 'audio' | 'video';
}

interface RequestData {
    [key: string]: string | boolean | RtpCapabilities | undefined;
}

interface ConsumedData {
    id: string;
    producerId: string;
    kind: 'audio' | 'video';
    rtpParameters: mediasoupClient.types.RtpParameters;
}

export default function StreamPage() {
    const [isConnected, setIsConnected] = useState(false);
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remoteStreams, setRemoteStreams] = useState<RemoteStream[]>([]);

    const socketRef = useRef<WebSocket | null>(null);
    const deviceRef = useRef<mediasoupClient.Device | null>(null);
    const sendTransportRef = useRef<Transport | null>(null);
    const recvTransportRef = useRef<Transport | null>(null);
    const producersRef = useRef<Map<string, Producer>>(new Map());
    const consumersRef = useRef<Map<string, Consumer>>(new Map());
    const localVideoRef = useRef<HTMLVideoElement>(null);
    const requestQueue = useRef<Map<string, (data: unknown) => void>>(new Map());

    //websocket comms
    const connectSocket = () => {
        const peerId = `peer_${Date.now()}`;
        const socket = new WebSocket(SERVER_URL, peerId);

        socket.onopen = () => {
            console.log(`[ws] WebSocket connected`);
            setIsConnected(true);
            socketRef.current = socket;
        };

        socket.onmessage = async (event) => {
            const { event: messageEvent, data, requestId } = JSON.parse(event.data);
            console.log(`[ws] Received message:`, messageEvent, data);

            if (requestId && requestQueue.current.has(requestId)) {
                requestQueue.current.get(requestId)!(data);
                requestQueue.current.delete(requestId);
                return;
            }

            switch (messageEvent) {
                case 'routerRtpCapabilities':
                    await handleRouterRtpCapabilities(data);
                    break;
                case 'new-producer':
                    await consumeNewProducer(data.producerId);
                    break;
                case 'consumer-closed':
                    handleConsumerClosed(data.consumerId);
                    break;
            }
        };

        socket.onclose = () => {
            console.log(`[ws] WebSocket disconnected`);
            setIsConnected(false);
        };

        socket.onerror = (error) => {
            console.error(`[ws] WebSocket error : `, error);
        };
    };

    const request = <T,>(event: string, data: RequestData): Promise<T> => {
        return new Promise((resolve, reject) => {
            const requestId = `${event}_${Date.now()}`;
            const timeout = setTimeout(() => {
                requestQueue.current.delete(requestId);
                reject(new Error(`Request timed out for event: ${event}`));
            }, 5000);

            requestQueue.current.set(requestId, (responseData) => {
                clearTimeout(timeout);
                resolve(responseData as T);
            });

            if (socketRef.current?.readyState === WebSocket.OPEN) {
                socketRef.current.send(JSON.stringify({ event, data, requestId }));
            } else {
                reject(new Error("WebSocket is not connected."));
            }
        });
    };

    //mediasoup logic
    const startStreaming = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            setLocalStream(stream);
            if (localVideoRef.current) {
                localVideoRef.current.srcObject = stream;
            }
            connectSocket();
        } catch (error) {
            console.error(`Error getting user media: `, error);
        }
    };

    const handleRouterRtpCapabilities = async (routerRtpCapabilities: RtpCapabilities) => {
        const device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities });
        deviceRef.current = device;

        // Create transports first
        await createSendTransport();
        await createRecvTransport();

        // Now that transports are ready, produce media
        if (sendTransportRef.current) {
            produceMedia(sendTransportRef.current);
        }
    };

    const createSendTransport = async () => {
        const params = await request('createWebRtcTransport', { isSender: true });
        const transport = deviceRef.current!.createSendTransport(params);

        transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
            try {
                await request('connectWebRtcTransport', { transportId: transport.id, dtlsParameters });
                callback();
            } catch (error) {
                errback(error as Error);
            }
        });

        transport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
            try {
                const { id } = await request('produce', { transportId: transport.id, kind, rtpParameters, appData });
                callback({ id });
            } catch (error) {
                errback(error as Error);
            }
        });

        sendTransportRef.current = transport;
    };

    const createRecvTransport = async () => {
        const params = await request('createWebRtcTransport', { isSender: false });
        const transport = deviceRef.current!.createRecvTransport(params);

        transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
            try {
                await request('connectWebRtcTransport', { transportId: transport.id, dtlsParameters });
                callback();
            } catch (error) {
                errback(error as Error);
            }
        });

        recvTransportRef.current = transport;
    };

    const produceMedia = async (transport: Transport) => {
        if (!localStream || !transport) return;

        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            try {
                const videoProducer = await transport.produce({ track: videoTrack });
                producersRef.current.set(videoProducer.id, videoProducer);
            } catch (err) {
                console.error('Failed to produce video:', err);
            }
        }

        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            try {
                const audioProducer = await transport.produce({ track: audioTrack });
                producersRef.current.set(audioProducer.id, audioProducer);
            } catch (err) {
                console.error('Failed to produce audio:', err);
            }
        }
    };

    const consumeNewProducer = async (producerId: string) => {
        const device = deviceRef.current;
        if (!device || !recvTransportRef.current) {
            console.log('Device or recv transport not ready for consuming');
            return;
        }

        try {
            const data = await request('consume', {
                transportId: recvTransportRef.current.id,
                producerId,
                rtpCapabilities: device.rtpCapabilities,
            });

            if (data) {
                await handleConsumed(data);
            }
        } catch (err) {
            console.error('Failed to consume new producer:', err);
        }
    };

    const handleConsumed = async (data: ConsumedData) => {
        const { id, producerId, kind, rtpParameters } = data;
        const transport = recvTransportRef.current;
        if (!transport) return;

        const consumer = await transport.consume({
            id,
            producerId,
            kind,
            rtpParameters,
        });
        consumersRef.current.set(consumer.id, consumer);

        const { track } = consumer;
        const newStream = new MediaStream([track]);

        setRemoteStreams(prev => {
            if (prev.find(s => s.id === consumer.id)) return prev;
            return [...prev, { id: consumer.id, producerId, stream: newStream, kind }];
        });

        request('resume-consumer', { consumerId: consumer.id });
    };

    const handleConsumerClosed = (consumerId: string) => {
        console.log(`[mediasoup] Consumer ${consumerId} closed`);
        consumersRef.current.delete(consumerId);
        setRemoteStreams(prev => prev.filter(s => s.id !== consumerId));
    };

    useEffect(() => {
        if (isConnected && localStream && !deviceRef.current) {
            if (socketRef.current?.readyState === WebSocket.OPEN) {
                socketRef.current.send(JSON.stringify({ event: 'getRouterRtpCapabilities', data: {} }));
            }
        }
    }, [isConnected, localStream]);

    useEffect(() => {
        return () => {
            socketRef.current?.close();
            localStream?.getTracks().forEach(track => track.stop());
            sendTransportRef.current?.close();
            recvTransportRef.current?.close();
        };
    }, [localStream]);

    return (
        <div className="min-h-screen bg-gray-900 text-white p-4">
            <h1 className="text-3xl font-bold text-center mb-4">WebRTC Stream Page</h1>
            <div className="flex justify-center mb-4">
                {!localStream ? (
                    <button
                        onClick={startStreaming}
                        className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg shadow-lg"
                    >
                        Start Camera and Join
                    </button>
                ) : (
                    <button
                        onClick={() => window.location.reload()}
                        className="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-lg shadow-lg"
                    >
                        Stop Streaming and Leave
                    </button>
                )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-gray-800 p-2 rounded-lg">
                    <h2 className="text-xl mb-2">My Stream</h2>
                    <video ref={localVideoRef} autoPlay muted className="w-full rounded-md bg-black "></video>
                </div>
                <div className="bg-gray-800 p-2 rounded-lg">
                    <h2 className="text-xl mb-2">Remote Streams</h2>
                    <div id="remote-videos" className="space-y-4">
                        {
                            remoteStreams.map(({ id, stream }) => (
                                <video
                                    key={id}
                                    autoPlay
                                    className="w-full rounded-md bg-black"
                                    ref={video => {
                                        if (video) video.srcObject = stream;
                                    }}
                                ></video>
                            ))
                        }
                        {remoteStreams.length === 0 && <p className="text-gray-400">Waiting for other participants...</p>}
                    </div>
                </div>
            </div>
        </div>
    );
}