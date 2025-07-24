'use client'

import { useEffect, useRef, useState } from "react";
import * as mediasoupClient from 'mediasoup-client';
import { Consumer, Producer, Transport } from "mediasoup-client/types";
import { RtpCapabilities } from "mediasoup/types";

const SERVER_URL = 'ws://localhost:3001';

interface RemoteStream {
    id : string;
    producerId: string;
    stream : MediaStream;
    kind : 'audio' | 'video';
}

export default function StreamPage() {
    const [isConnected, setIsConnected] = useState(false);
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remoteStreams, setRemoteStreams] = useState<RemoteStream[]>([]);

    const socketRef = useRef<WebSocket | null>(null);
    const deviseRef = useRef<mediasoupClient.Device | null>(null);
    const sendTransportRef = useRef<Transport | null>(null);
    const recvTransportRef = useRef<Transport | null>(null);
    const producersRef = useRef<Map<string,Producer>>(new Map());
    const consumersRef = useRef<Map<string, Consumer>>(new Map());
    const localVideoRef = useRef<HTMLVideoElement>(null);

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
            const { event : messageEvent, data } = JSON.parse(event.data);
            console.log(`[ws] Recieved message:`, messageEvent, data);

            switch (messageEvent) {
                case 'routerRtpCapabilities':
                  await handleRouterRtpCapabilities(data);
                  break;
                case 'webRtcTransportCreated':
                  await handleTransportCreated(data);
                  break;
                case 'transportConnected':
                  // This is a confirmation, no action needed on send transport
                  // For recv transport, we might want to start consuming
                  break;
                case 'produced':
                  // This is a confirmation that our producer was created on the server
                  console.log(`[mediasoup] Our producer with id ${data.id} was created`);
                  break;
                case 'new-producer':
                  // A new peer has started sending media
                  await consumeNewProducer(data.producerId);
                  break;
                case 'consumed':
                  await handleConsumed(data);
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

    const sendMessage = (event : string, data : any) => {
        if (socketRef.current?.readyState == WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({ event, data }));
        }
    };

    //mediasoup logic
    // get user media and initialize connection
    const startStreaming = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio : true });
            setLocalStream(stream);
            if (localVideoRef.current) {
                localVideoRef.current.srcObject = stream
            }
            connectSocket();
        } catch (error) {
            console.error(`Error getting user media: `, error);
        }
    };

    //load router capabilities and create device
    const handleRouterRtpCapabilities = async (routerRtpCapabilities : RtpCapabilities) => {
        const device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities });
        deviseRef.current = device;

        //once the device is loaded, create transports
        sendMessage('createWebRtcTransport', { isSender : true });
        sendMessage('createWebRtcTransport', { isSender : false });
    };

    const handleTransportCreated = async (params : any) => {
        const device = deviseRef.current;
        if (!device) return;

        // Check if this is a send or receive transport based on our request logic
        // A more robust way would be to pass an identifier in the request
        if (!sendTransportRef.current) {
            const transport  =device.createSendTransport(params);
            transport.on('connect', async ({ dtlsParameters }, callback) => {
                console.log(`[mediasoup] send transport connecting... `);
                sendMessage('connectWebRtcTransport', { transportId : transport.id, dtlsParameters });
                socketRef.current!.addEventListener('message', (event) => {
                    const msg = JSON.parse(event.data);
                    if (msg.event === 'transportConnected' && msg.data.transportId === transport.id) {
                        console.log(`[mediasoup] Send transport connected`);
                        callback();
                    }
                });  
            });

            transport.on('produce', async ({ kind, rtpParameters, appData }, callback) => {
                console.log(`[mediasoup] Producing ${kind}...`);
                sendMessage('produce', { transportId : transport.id, kind, rtpParameters, appData });
                socketRef.current!.addEventListener('message', (event) => {
                    const msg = JSON.parse(event.data);
                    if (msg.event === 'produced' && msg.data.id) {
                        console.log(`[mediasoup] Produced ${kind} successfully`);
                        callback({ id : msg.data.id });
                    }
                });
            });

            sendTransportRef.current = transport;
            //start producing media
            producerMedia(transport);
        } else {
            const transport = device.createRecvTransport(params);
            transport.on('connect', ({ dtlsParameters }, callback) => {
                console.log(`[mediasoup] Recv transport connected...`);
                sendMessage('connectWebRtcTransport', { transportId : transport.id, dtlsParameters });
                socketRef.current!.addEventListener('message', (event) => {
                    const msg = JSON.parse(event.data);
                    if (msg.event === 'transportConnected' && msg.data.transportId === transport.id) {
                        console.log(`[mediasoup] Recv transport connected!`);
                        callback();
                    }
                });         
            });
            recvTransportRef.current = transport;
        }
    };

    //produce audio and video tracks
    const producerMedia = async (transport : Transport) => {
        if (!localStream || !transport) return;

        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            const videoProducer = await transport.produce({ track : videoTrack });
            producersRef.current.set(videoProducer.id, videoProducer);
        }

        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            const audioProducer = await transport.produce({ track : audioTrack });
            producersRef.current.set(audioProducer.id, audioProducer);
        }
    };

    // a new producer is available, create a consumer for it
    const consumeNewProducer = async (producerId : string) => {
        const device = deviseRef.current;
        if(!device || !recvTransportRef.current) return;

        console.log(`[mediasoup] Subscribing to new producer : ${producerId}`);
        sendMessage('consume', {
            transportId : recvTransportRef.current.id,
            producerId,
            rtpCapabilities : device.rtpCapabilities,
        });
    };

    //server has created the consumer, now create it locally
    const handleConsumed = async (data : any) => {
        const { id, producerId, kind, rtpParameters } = data;
        const transport = recvTransportRef.current;
        if (!transport) return;

        const consumer = await transport.consume({
            id,
            producerId,
            kind,
            rtpParameters
        });
        consumersRef.current.set(consumer.id, consumer);

        const { track } = consumer;
        const newStream = new MediaStream([track]);

        setRemoteStreams(prev => [...prev, { id : consumer.id, producerId, stream : newStream, kind }]);

        //resume the consumer on the server to start recieving media
        sendMessage('resume-consumer', { consumerId : consumer.id });
    };

    const handleConsumerClosed = (consumerId : string) => {
        console.log(`[mediasoup] Consumer ${consumerId} closed`);
        const producerId = consumersRef.current.get(consumerId)?.producerId;
        consumersRef.current.delete(consumerId);
        setRemoteStreams(prev => prev.filter(s => s.id !== consumerId)); 
    };

    useEffect(() => {
        if (isConnected && localStream && !deviseRef.current) {
          // Once connected and with a stream, get router capabilities
          sendMessage('getRouterRtpCapabilities', {});
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
                            remoteStreams.map(({id, stream}) => (
                                <video 
                                    key={id}
                                    autoPlay
                                    className="w-full rounded-md bg-black"
                                    ref = {video => {
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