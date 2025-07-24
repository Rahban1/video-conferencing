'use client'

import { useEffect, useRef, useState } from "react";
import * as mediasoupClient from 'mediasoup-client';
import { Consumer, Producer, Transport, RtpCapabilities } from "mediasoup-client/types";

const SERVER_URL = typeof window !== 'undefined' 
    ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}:3001`
    : 'ws://localhost:3001';

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
        console.log(`[ws] Connecting with peerId: ${peerId}`);
        const socket = new WebSocket(SERVER_URL, peerId);

        socket.onopen = () => {
            console.log(`[ws] WebSocket connected with peerId: ${peerId}`);
            setIsConnected(true);
            socketRef.current = socket;
            // Request router capabilities immediately after connection
            requestRouterCapabilities();
        };

        socket.onmessage = async (event) => {
            const { event: messageEvent, data, requestId } = JSON.parse(event.data);
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
                    console.log(`[ws] Current device ready state: ${isDeviceReady}`);
                    if (deviceRef.current && recvTransportRef.current) {
                        console.log('[ws] Device and transport ready, consuming new producer immediately');
                        await consumeNewProducer(data.producerId);
                    } else {
                        console.log('[ws] Device or transport not ready, adding to pending producers');
                        console.log(`[ws] Device ref: ${!!deviceRef.current}, Recv transport: ${!!recvTransportRef.current}`);
                        pendingProducers.current.push(data.producerId);
                    }
                    break;
                case 'consumer-closed':
                    console.log(`[ws] Consumer closed: ${data.consumerId}`);
                    handleConsumerClosed(data.consumerId);
                    break;
                case 'error':
                    console.error(`[ws] Server error: ${data}`);
                    break;
                default:
                    console.log(`[ws] Unhandled message event: ${messageEvent}`);
            }
        };

        socket.onclose = () => {
            console.log(`[ws] WebSocket disconnected`);
            setIsConnected(false);
            setIsDeviceReady(false);
            // Clear refs on disconnect
            deviceRef.current = null;
            sendTransportRef.current = null;
            recvTransportRef.current = null;
        };

        socket.onerror = (error) => {
            console.error(`[ws] WebSocket error : `, error);
        };
    };

    const requestRouterCapabilities = () => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({ 
                event: 'getRouterRtpCapabilities', 
                data: {},
                requestId: `getRouterRtpCapabilities_${Date.now()}_${Math.random()}`
            }));
        }
    };

    const request = <T,>(event: string, data: RequestData): Promise<T> => {
        return new Promise((resolve, reject) => {
            const requestId = `${event}_${Date.now()}_${Math.random()}`;

            const timeout = setTimeout(() => {
                requestQueue.current.delete(requestId);
                reject(new Error(`Request timed out for event: ${event}`));
            }, 10000); // Increased timeout

            requestQueue.current.set(requestId, (responseData) => {
                clearTimeout(timeout);
                resolve(responseData as T);
            });

            if (socketRef.current?.readyState === WebSocket.OPEN) {
                socketRef.current.send(JSON.stringify({ event, data, requestId }));
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
            // Check if mediaDevices is supported
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('getUserMedia is not supported in this browser or context. Please use HTTPS or localhost.');
            }

            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: 640, height: 480 },
                audio: true
            });
            setLocalStream(stream);
            // Connect socket and proceed with mediasoup setup only after localStream is set
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

            // Create transports
            await createSendTransport();
            await createRecvTransport();

            setIsDeviceReady(true);

            // Produce media after transports are ready
            if (sendTransportRef.current) {
                console.log('[mediasoup] Device ready, attempting to produce media');
                console.log('[mediasoup] Local stream available:', !!localStream);
                if (localStream) {
                    await produceMedia(sendTransportRef.current);
                } else {
                    console.log('[mediasoup] Local stream not available yet, will produce when ready');
                }
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
            console.log('[mediasoup] Local stream:', !!localStream);
            console.log('[mediasoup] Transport:', !!transport);
            return;
        }

        console.log('[mediasoup] Starting media production');
        console.log('[mediasoup] Transport connection state:', transport.connectionState);

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
            } else {
                console.log('[mediasoup] No video track available in localStream');
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
            } else {
                console.log('[mediasoup] No audio track available in localStream');
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
            const data = await request('consume', {
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
            console.log(`[mediasoup] Creating consumer for producer: ${producerId}`);
            const consumer = await transport.consume({
                id,
                producerId,
                kind,
                rtpParameters,
            });
            
            consumersRef.current.set(consumer.id, consumer);
    
            // **ADD CONSUMER EVENT HANDLERS**
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
            
            // **ADD TRACK VALIDATION**
            if (!track) {
                console.error('No track received from consumer');
                return;
            }
    
            console.log(`Received ${kind} track:`, track.id, track.readyState);
            
            const newStream = new MediaStream([track]);
    
            setRemoteStreams(prev => {
                if (prev.find(s => s.id === consumer.id)) return prev;
                console.log(`[mediasoup] Adding remote stream: ${consumer.id}`);
                return [...prev, { id: consumer.id, producerId, stream: newStream, kind }];
            });
    
            // **IMPROVED RESUME WITH RETRY**
            try {
                await request('resume-consumer', { consumerId: consumer.id });
                console.log(`[mediasoup] Consumer resumed: ${consumer.id}`);
                
                // **ADD TRACK STATE LOGGING**
                setTimeout(() => {
                    console.log(`Track state after resume - ID: ${track.id}, ReadyState: ${track.readyState}, Enabled: ${track.enabled}`);
                }, 1000);
                
            } catch (resumeError) {
                console.error('Error resuming consumer:', resumeError);
                // Retry resume
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
        setRemoteStreams(prev => prev.filter(s => s.id !== consumerId));
    };

    useEffect(() => {
        if (localVideoRef.current && localStream) {
            console.log('[mediasoup] Assigning localStream to video element:', localStream);
            localVideoRef.current.srcObject = localStream;
        }
    }, [localStream]);

    useEffect(() => {
        // When local stream becomes available and device is ready, produce media
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

    // **ADD THIS DEBUGGING FUNCTION TO YOUR COMPONENT**
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
                {/* <button
                    onClick={debugStreamState}
                    className="bg-yellow-600 hover:bg-yellow-700 text-white font-bold py-2 px-4 rounded-lg shadow-lg"
                >
                    Debug Stream State
                </button> */}
            </div>

            <div className="text-center mb-4">
                <p>Connection Status: {isConnected ? '🟢 Connected' : '🔴 Disconnected'}</p>
                <p>Device Status: {isDeviceReady ? '🟢 Ready' : '🔴 Not Ready'}</p>
                <p>Remote Streams: {remoteStreams.length}</p>
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
                    <h2 className="text-xl mb-2">Remote Streams ({remoteStreams.length})</h2>
                    <div id="remote-videos" className="space-y-4">
                    {remoteStreams.map(({ id, stream, kind }) => (
                    <div key={id} className="relative">
                        <video
                            autoPlay
                            playsInline
                            muted={false} // **CHANGE: Don't mute remote streams**
                            controls // **ADD: Temporary controls for debugging**
                            className="w-full rounded-md bg-black"
                            onLoadedMetadata={(e) => {
                                console.log(`Video metadata loaded for ${id}:`, {
                                    videoWidth: e.currentTarget.videoWidth,
                                    videoHeight: e.currentTarget.videoHeight,
                                    duration: e.currentTarget.duration
                                });
                            }}
                            onError={(e) => {
                                console.error(`Video error for ${id}:`, e);
                            }}
                            onPlay={() => console.log(`Video playing: ${id}`)}
                            onPause={() => console.log(`Video paused: ${id}`)}
                            ref={video => {
                                if (video && video.srcObject !== stream) {
                                    console.log(`[mediasoup] Assigning remote stream ${id} to video element:`, stream);
                                    console.log('Stream tracks:', stream.getTracks());
                                    video.srcObject = stream;
                                    
                                    // **ADD PLAY PROMISE HANDLING**
                                    const playPromise = video.play();
                                    if (playPromise !== undefined) {
                                        playPromise.catch(error => {
                                            console.error(`Error playing video ${id}:`, error);
                                        });
                                    }
                                }
                            }}
                        />
                        <div className="absolute top-2 left-2 bg-black bg-opacity-50 text-white px-2 py-1 text-xs rounded">
                            {kind} - {id.substring(0, 8)}
                        </div>
                    </div>
                ))}
                        {remoteStreams.length === 0 && (
                            <p className="text-gray-400">Waiting for other participants...</p>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}