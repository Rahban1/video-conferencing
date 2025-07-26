'use client'

import { useEffect, useRef, useState } from "react";
import * as mediasoupClient from 'mediasoup-client';
import { Consumer, Producer, Transport, RtpCapabilities } from "mediasoup-client/types";

// Determine the correct WebSocket URL based on the current page protocol
const getWebSocketURL = () => {
    if (typeof window === 'undefined') return 'ws://localhost:3001';
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const hostname = window.location.hostname;
    
    return `${protocol}//${hostname}:3001`;
};

const SERVER_URL = getWebSocketURL();

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
    const [isDeviceReady, setIsDeviceReady] = useState(false);

    const socketRef = useRef<WebSocket | null>(null);
    const deviceRef = useRef<mediasoupClient.Device | null>(null);
    const sendTransportRef = useRef<Transport | null>(null);
    const recvTransportRef = useRef<Transport | null>(null);
    const producersRef = useRef<Map<string, Producer>>(new Map());
    const consumersRef = useRef<Map<string, Consumer>>(new Map());
    const localVideoRef = useRef<HTMLVideoElement>(null);
    const requestQueue = useRef<Map<string, (data: unknown) => void>>(new Map());
    const pendingProducers = useRef<string[]>([]);

    //websocket comms
    const connectSocket = () => {
        const peerId = `peer_${Date.now()}_${Math.random()}`;
        console.log(`[ws] Connecting with peerId: ${peerId} to ${SERVER_URL}`);
        
        try {
            const socket = new WebSocket(SERVER_URL, peerId);

            socket.onopen = () => {
                console.log(`[ws] WebSocket connected with peerId: ${peerId}`);
                setIsConnected(true);
                socketRef.current = socket;
                requestRouterCapabilities();
            };

            socket.onmessage = async (event) => {
                const message = JSON.parse(event.data);
                const { event: messageEvent, data, id: requestId } = message;
                console.log(`[ws] Received message:`, messageEvent, data);

                if (requestId && requestQueue.current.has(requestId)) {
                    console.log(`[ws] Handling request response for: ${requestId}`);
                    requestQueue.current.get(requestId)!(data);
                    requestQueue.current.delete(requestId);
                    return;
                }

                switch (messageEvent) {
                    case 'routerRtpCapabilities':
                        console.log('[ws] Received router RTP capabilities');
                        await handleRouterRtpCapabilities(data);
                        break;
                    case 'new-producer':
                        console.log(`[ws] Received new-producer event: ${data.producerId}`);
                        if (deviceRef.current && recvTransportRef.current) {
                            console.log('[ws] Device and transport ready, consuming new producer immediately');
                            await consumeNewProducer(data.producerId);
                        } else {
                            console.log('[ws] Device or transport not ready, adding to pending producers');
                            pendingProducers.current.push(data.producerId);
                        }
                        break;
                    case 'consumer-closed':
                        console.log(`[ws] Consumer closed: ${data.consumerId}`);
                        handleConsumerClosed(data.consumerId);
                        break;
                    case 'producer-closed':
                        console.log(`[ws] Producer closed: ${data.producerId}`);
                        handleProducerClosed(data.producerId);
                        break;
                    case 'error':
                        console.error(`[ws] Server error: ${data.message}`);
                        break;
                    default:
                        console.log(`[ws] Unhandled message event: ${messageEvent}`);
                }
            };

            socket.onclose = (event) => {
                console.log(`[ws] WebSocket disconnected:`, event.code, event.reason);
                setIsConnected(false);
                setIsDeviceReady(false);
                deviceRef.current = null;
                sendTransportRef.current = null;
                recvTransportRef.current = null;
                
                // Show user-friendly error message
                if (event.code === 1006) {
                    alert('Connection failed: Server might not be running on port 3001. Please check if the server is started with "npm run dev:server"');
                }
            };

            socket.onerror = (error) => {
                console.error(`[ws] WebSocket error:`, error);
                alert('WebSocket connection failed. Please ensure:\n1. Server is running on port 3001\n2. Run "npm run dev:server" in another terminal\n3. Check if port 3001 is not blocked by firewall');
            };
            
        } catch (error) {
            console.error('[ws] Failed to create WebSocket:', error);
            alert('Failed to create WebSocket connection. Please check the server URL and ensure the server is running.');
        }
    };

    const requestRouterCapabilities = () => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            const requestId = `getRouterRtpCapabilities_${Date.now()}_${Math.random()}`;
            socketRef.current.send(JSON.stringify({ 
                event: 'getRouterRtpCapabilities', 
                data: {},
                id: requestId
            }));
        }
    };

    const request = <T,>(event: string, data: RequestData): Promise<T> => {
        return new Promise((resolve, reject) => {
            const requestId = `${event}_${Date.now()}_${Math.random()}`;

            const timeout = setTimeout(() => {
                requestQueue.current.delete(requestId);
                reject(new Error(`Request timed out for event: ${event}`));
            }, 15000);

            requestQueue.current.set(requestId, (responseData) => {
                clearTimeout(timeout);
                resolve(responseData as T);
            });

            if (socketRef.current?.readyState === WebSocket.OPEN) {
                socketRef.current.send(JSON.stringify({ event, data, id: requestId }));
            } else {
                clearTimeout(timeout);
                requestQueue.current.delete(requestId);
                reject(new Error("WebSocket is not connected."));
            }
        });
    };

    //mediasoup logic
    const startStreaming = async () => {
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('getUserMedia is not supported in this browser or context. Please use HTTPS or localhost.');
            }

            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: 640, height: 480 },
                audio: true
            });
            setLocalStream(stream);
            connectSocket();
        } catch (error) {
            console.error(`Error getting user media: `, error);
            alert(`Camera access failed: ${error.message}\n\nPlease:\n1. Use localhost instead of IP address\n2. Ensure HTTPS is enabled\n3. Grant camera/microphone permissions`);
        }
    };

    const handleRouterRtpCapabilities = async (routerRtpCapabilities: RtpCapabilities) => {
        try {
            console.log('[mediasoup] Loading device with router capabilities');
            const device = new mediasoupClient.Device();
            await device.load({ routerRtpCapabilities });
            deviceRef.current = device;

            await createSendTransport();
            await createRecvTransport();

            setIsDeviceReady(true);

            if (sendTransportRef.current && localStream) {
                console.log('[mediasoup] Device ready, producing media');
                await produceMedia(sendTransportRef.current);
            }

            // Consume any pending producers
            for (const producerId of pendingProducers.current) {
                await consumeNewProducer(producerId);
            }
            pendingProducers.current = [];

        } catch (error) {
            console.error('Error handling router RTP capabilities:', error);
        }
    };

    const createSendTransport = async () => {
        try {
            console.log('[mediasoup] Creating send transport');
            const params = await request('createWebRtcTransport', {});
            const transport = deviceRef.current!.createSendTransport(params);

            transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                try {
                    console.log('[mediasoup] Send transport connecting...');
                    await request('connectWebRtcTransport', { 
                        transportId: transport.id, 
                        dtlsParameters 
                    });
                    console.log('[mediasoup] Send transport connected successfully');
                    callback();
                } catch (error) {
                    console.error('Send transport connect error:', error);
                    errback(error as Error);
                }
            });

            transport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
                try {
                    console.log(`[mediasoup] Transport requesting to produce ${kind}`);
                    const { id } = await request('produce', { 
                        transportId: transport.id, 
                        kind, 
                        rtpParameters, 
                        appData 
                    });
                    console.log(`[mediasoup] Server confirmed producer creation: ${id}`);
                    callback({ id });
                } catch (error) {
                    console.error('Produce error:', error);
                    errback(error as Error);
                }
            });

            transport.on('connectionstatechange', (state) => {
                console.log(`[mediasoup] Send transport connection state: ${state}`);
            });

            sendTransportRef.current = transport;
        } catch (error) {
            console.error('Error creating send transport:', error);
        }
    };

    const createRecvTransport = async () => {
        try {
            console.log('[mediasoup] Creating receive transport');
            const params = await request('createWebRtcTransport', {});
            const transport = deviceRef.current!.createRecvTransport(params);

            transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
                try {
                    console.log('[mediasoup] Recv transport connecting...');
                    await request('connectWebRtcTransport', { 
                        transportId: transport.id, 
                        dtlsParameters 
                    });
                    console.log('[mediasoup] Recv transport connected successfully');
                    callback();
                } catch (error) {
                    console.error('Recv transport connect error:', error);
                    errback(error as Error);
                }
            });

            transport.on('connectionstatechange', (state) => {
                console.log(`[mediasoup] Receive transport connection state: ${state}`);
            });

            recvTransportRef.current = transport;
        } catch (error) {
            console.error('Error creating receive transport:', error);
        }
    };

    const produceMedia = async (transport: Transport) => {
        if (!localStream || !transport) {
            console.log('[mediasoup] Cannot produce media - missing stream or transport');
            return;
        }

        console.log('[mediasoup] Starting media production');

        try {
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack) {
                console.log('[mediasoup] Producing video track:', videoTrack.label);
                const videoProducer = await transport.produce({ track: videoTrack });
                producersRef.current.set(videoProducer.id, videoProducer);
                console.log(`[mediasoup] Video producer created: ${videoProducer.id}`);
                
                videoProducer.on('transportclose', () => {
                    console.log(`[mediasoup] Video producer transport closed: ${videoProducer.id}`);
                });
            }

            const audioTrack = localStream.getAudioTracks()[0];
            if (audioTrack) {
                console.log('[mediasoup] Producing audio track:', audioTrack.label);
                const audioProducer = await transport.produce({ track: audioTrack });
                producersRef.current.set(audioProducer.id, audioProducer);
                console.log(`[mediasoup] Audio producer created: ${audioProducer.id}`);
                
                audioProducer.on('transportclose', () => {
                    console.log(`[mediasoup] Audio producer transport closed: ${audioProducer.id}`);
                });
            }
            
            console.log(`[mediasoup] Total producers created: ${producersRef.current.size}`);
        } catch (error) {
            console.error('[mediasoup] Error producing media:', error);
        }
    };

    const consumeNewProducer = async (producerId: string) => {
        const device = deviceRef.current;
        const transport = recvTransportRef.current;
        
        if (!device || !transport) {
            console.log('Device or recv transport not ready for consuming');
            return;
        }
    
        // Don't consume our own producers
        if (producersRef.current.has(producerId)) {
            console.log('Skipping consumption of own producer');
            return;
        }
    
        try {
            console.log(`[mediasoup] Consuming producer: ${producerId}`);
            const data = await request<ConsumedData>('consume', {
                transportId: transport.id,
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
    
        try {
            console.log(`[mediasoup] Creating consumer for producer: ${producerId} (${kind})`);
            const consumer = await transport.consume({
                id,
                producerId,
                kind,
                rtpParameters,
            });
            
            consumersRef.current.set(consumer.id, consumer);
    
            consumer.on('transportclose', () => {
                console.log(`Consumer transport closed: ${consumer.id}`);
                handleConsumerClosed(consumer.id);
            });
    
            consumer.on('producerclose', () => {
                console.log(`Consumer producer closed: ${consumer.id}`);
                handleConsumerClosed(consumer.id);
            });
    
            consumer.on('trackended', () => {
                console.log(`Consumer track ended: ${consumer.id}`);
            });
    
            const { track } = consumer;
            
            if (!track) {
                console.error('No track received from consumer');
                return;
            }
    
            console.log(`Received ${kind} track:`, track.id, track.readyState);
            
            // Update remote streams state - combine audio and video from same producer
            setRemoteStreams(prev => {
                const existingIndex = prev.findIndex(s => s.producerId === producerId);
                
                if (existingIndex !== -1) {
                    // Update existing stream by adding the new track
                    const updatedStreams = [...prev];
                    const existingStream = updatedStreams[existingIndex];
                    
                    // Add the new track to the existing MediaStream
                    existingStream.stream.addTrack(track);
                    
                    console.log(`[mediasoup] Added ${kind} track to existing stream for producer: ${producerId}`);
                    return updatedStreams;
                } else {
                    // Create new stream entry
                    const newStream = new MediaStream([track]);
                    const remoteStream = { 
                        id: `stream_${producerId}`, // Use producer ID as base for stream ID
                        producerId, 
                        stream: newStream, 
                        kind 
                    };
                    console.log(`[mediasoup] Creating new remote stream for producer: ${producerId} (${kind})`);
                    return [...prev, remoteStream];
                }
            });
    
            // Resume the consumer
            try {
                await request('resume-consumer', { consumerId: consumer.id });
                console.log(`[mediasoup] Consumer resumed: ${consumer.id}`);
                
                setTimeout(() => {
                    console.log(`Track state after resume - ID: ${track.id}, ReadyState: ${track.readyState}, Enabled: ${track.enabled}`);
                }, 1000);
                
            } catch (resumeError) {
                console.error('Error resuming consumer:', resumeError);
                // Retry resume after delay
                setTimeout(async () => {
                    try {
                        await request('resume-consumer', { consumerId: consumer.id });
                        console.log(`[mediasoup] Consumer resumed on retry: ${consumer.id}`);
                    } catch (retryError) {
                        console.error('Retry resume failed:', retryError);
                    }
                }, 2000);
            }
            
        } catch (error) {
            console.error('Error handling consumed data:', error);
        }
    };

    const handleConsumerClosed = (consumerId: string) => {
        console.log(`[mediasoup] Consumer ${consumerId} closed`);
        consumersRef.current.delete(consumerId);
        
        // Don't remove streams here since we're using producer-based grouping
        // The stream will be removed when the producer closes
    };

    const handleProducerClosed = (producerId: string) => {
        console.log(`[mediasoup] Producer ${producerId} closed`);
        setRemoteStreams(prev => prev.filter(s => s.producerId !== producerId));
    };

    useEffect(() => {
        if (localVideoRef.current && localStream) {
            console.log('[mediasoup] Assigning localStream to video element:', localStream);
            localVideoRef.current.srcObject = localStream;
        }
    }, [localStream]);

    useEffect(() => {
        if (localStream && isDeviceReady && sendTransportRef.current) {
            console.log('[useEffect] Local stream and device ready, producing media');
            produceMedia(sendTransportRef.current);
        }
    }, [localStream, isDeviceReady]);

    useEffect(() => {
        return () => {
            socketRef.current?.close();
            localStream?.getTracks().forEach(track => track.stop());
            sendTransportRef.current?.close();
            recvTransportRef.current?.close();
        };
    }, [localStream]);

    // Group remote streams by producer ID to handle audio/video pairs
    const groupedRemoteStreams = remoteStreams.reduce((acc, stream) => {
        if (!acc[stream.producerId]) {
            acc[stream.producerId] = stream; // Use the actual stream since we're combining tracks into one stream
        }
        return acc;
    }, {} as Record<string, RemoteStream>);

    const debugStreamState = () => {
        console.log('=== STREAM DEBUG INFO ===');
        console.log('Local stream:', localStream);
        console.log('Local stream tracks:', localStream?.getTracks().map(t => ({
            id: t.id,
            kind: t.kind,
            readyState: t.readyState,
            enabled: t.enabled
        })));
        
        console.log('Remote streams:', remoteStreams.length);
        remoteStreams.forEach((stream, index) => {
            console.log(`Remote stream ${index}:`, {
                id: stream.id,
                producerId: stream.producerId,
                kind: stream.kind,
                tracks: stream.stream.getTracks().map(t => ({
                    id: t.id,
                    kind: t.kind,
                    readyState: t.readyState,
                    enabled: t.enabled
                }))
            });
        });
        
        console.log('Producers:', Array.from(producersRef.current.entries()));
        console.log('Consumers:', Array.from(consumersRef.current.entries()));
        console.log('Device:', deviceRef.current);
        console.log('Send transport state:', sendTransportRef.current?.connectionState);
        console.log('Recv transport state:', recvTransportRef.current?.connectionState);
    };

    return (
        <div className="min-h-screen bg-gray-900 text-white p-4">
            <h1 className="text-3xl font-bold text-center mb-4">WebRTC Stream Page</h1>
            
            <div className="flex justify-center mb-4 space-x-4">
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
                <button
                    onClick={debugStreamState}
                    className="bg-yellow-600 hover:bg-yellow-700 text-white font-bold py-2 px-4 rounded-lg shadow-lg"
                >
                    Debug Stream State
                </button>
            </div>

            <div className="text-center mb-4">
                <p>Connection Status: {isConnected ? '🟢 Connected' : '🔴 Disconnected'}</p>
                <p>Device Status: {isDeviceReady ? '🟢 Ready' : '🔴 Not Ready'}</p>
                <p>Remote Streams: {remoteStreams.length} ({Object.keys(groupedRemoteStreams).length} participants)</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-gray-800 p-2 rounded-lg">
                    <h2 className="text-xl mb-2">My Stream</h2>
                    <video 
                        ref={localVideoRef} 
                        autoPlay 
                        muted 
                        playsInline
                        className="w-full rounded-md bg-black"
                    />
                </div>
                
                <div className="bg-gray-800 p-2 rounded-lg">
                    <h2 className="text-xl mb-2">Remote Streams ({Object.keys(groupedRemoteStreams).length})</h2>
                    <div id="remote-videos" className="space-y-4">
                        {Object.entries(groupedRemoteStreams).map(([producerId, stream]) => (
                            <div key={producerId} className="relative">
                                <video
                                    autoPlay
                                    playsInline
                                    muted={false}
                                    className="w-full rounded-md bg-black"
                                    onLoadedMetadata={(e) => {
                                        console.log(`Video metadata loaded for producer ${producerId}:`, {
                                            videoWidth: e.currentTarget.videoWidth,
                                            videoHeight: e.currentTarget.videoHeight,
                                            duration: e.currentTarget.duration
                                        });
                                    }}
                                    onError={(e) => {
                                        console.error(`Video error for producer ${producerId}:`, e);
                                    }}
                                    onPlay={() => console.log(`Video playing: producer ${producerId}`)}
                                    onPause={() => console.log(`Video paused: producer ${producerId}`)}
                                    ref={video => {
                                        if (video && video.srcObject !== stream.stream) {
                                            console.log(`[mediasoup] Assigning stream for producer ${producerId} to video element:`, stream.stream);
                                            console.log('Stream tracks:', stream.stream.getTracks().map(t => ({ kind: t.kind, id: t.id, readyState: t.readyState })));
                                            video.srcObject = stream.stream;
                                            
                                            const playPromise = video.play();
                                            if (playPromise !== undefined) {
                                                playPromise.catch(error => {
                                                    console.error(`Error playing video for producer ${producerId}:`, error);
                                                });
                                            }
                                        }
                                    }}
                                />
                                <div className="absolute top-2 left-2 bg-black bg-opacity-50 text-white px-2 py-1 text-xs rounded">
                                    Producer: {producerId.substring(0, 8)}
                                    <br />
                                    Tracks: {stream.stream.getTracks().map(t => t.kind.charAt(0).toUpperCase()).join('')}
                                </div>
                            </div>
                        ))}
                        {Object.keys(groupedRemoteStreams).length === 0 && (
                            <p className="text-gray-400">Waiting for other participants...</p>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}