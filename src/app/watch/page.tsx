'use client';

import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";

const HLS_STREAM_URL = '/hls/stream.m3u8';

export default function WatchPage() {
    const videoRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<Hls | null>(null);
    const [streamStatus, setStreamStatus] = useState<'loading' | 'ready' | 'playing' | 'error' | 'no-stream'>('loading');
    const [viewerCount, setViewerCount] = useState<number>(0);
    const [retryCount, setRetryCount] = useState<number>(0);

    const checkStreamAvailability = async (): Promise<boolean> => {
        try {
            const response = await fetch(HLS_STREAM_URL, { method: 'HEAD' });
            return response.ok;
        } catch (error) {
            console.log('[hls] Stream not yet available:', error);
            return false;
        }
    };

    const initPlayer = async () => {
        const videoElement = videoRef.current;
        if (!videoElement) return;

        console.log('[hls] Checking if stream is available...');
        const streamAvailable = await checkStreamAvailability();
        
        if (!streamAvailable) {
            console.log('[hls] Stream not available, will retry...');
            setStreamStatus('no-stream');
            
            // Retry after 3 seconds, max 10 retries
            if (retryCount < 10) {
                setTimeout(() => {
                    setRetryCount(prev => prev + 1);
                    initPlayer();
                }, 3000);
            } else {
                setStreamStatus('error');
            }
            return;
        }

        // Reset retry count on successful stream detection
        setRetryCount(0);
        setStreamStatus('ready');

        if (Hls.isSupported()) {
            console.log('[hls] Initializing HLS.js Player');
            
            // Destroy existing instance if any
            if (hlsRef.current) {
                hlsRef.current.destroy();
            }

            const hls = new Hls({
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                liveSyncDurationCount: 3,
                liveMaxLatencyDurationCount: 5,
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 90,
            });
            
            hlsRef.current = hls;
            
            hls.on(Hls.Events.MEDIA_ATTACHED, () => {
                console.log('[hls] Media attached to video element');
            });

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                console.log('[hls] Manifest parsed, starting playback');
                setStreamStatus('playing');
                videoElement.play().catch(e => {
                    console.error('[hls] Autoplay prevented:', e);
                    setStreamStatus('ready'); // User will need to click play
                });
            });

            hls.on(Hls.Events.LEVEL_LOADED, (event, data) => {
                console.log('[hls] Level loaded:', data.level);
            });

            hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
                console.log('[hls] Fragment loaded:', data.frag.sn);
            });

            hls.on(Hls.Events.ERROR, (event, data) => {
                console.error('[hls] HLS Error:', data);
                
                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            console.log('[hls] Fatal network error, trying to recover...');
                            setStreamStatus('error');
                            // Try to restart loading
                            setTimeout(() => {
                                if (hlsRef.current) {
                                    hlsRef.current.startLoad();
                                }
                            }, 1000);
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.log('[hls] Fatal media error, trying to recover...');
                            setStreamStatus('error');
                            setTimeout(() => {
                                if (hlsRef.current) {
                                    hlsRef.current.recoverMediaError();
                                }
                            }, 1000);
                            break;
                        default:
                            console.error('[hls] Unrecoverable fatal error');
                            setStreamStatus('error');
                            hls.destroy();
                            hlsRef.current = null;
                            break;
                    }
                } else {
                    // Non-fatal errors
                    console.warn('[hls] Non-fatal error:', data);
                }
            });

            // Load and attach
            hls.loadSource(HLS_STREAM_URL);
            hls.attachMedia(videoElement);
            
        } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
            console.log('[hls] Using native HLS support (Safari)');
            videoElement.src = HLS_STREAM_URL;
            
            videoElement.addEventListener('loadedmetadata', () => {
                console.log('[hls] Native HLS metadata loaded');
                setStreamStatus('playing');
                videoElement.play().catch(e => {
                    console.error('[hls] Autoplay prevented:', e);
                    setStreamStatus('ready');
                });
            });

            videoElement.addEventListener('error', (e) => {
                console.error('[hls] Native video error:', e);
                setStreamStatus('error');
            });
        } else {
            console.error('[hls] HLS not supported in this browser');
            setStreamStatus('error');
        }
    };

    const handlePlayClick = () => {
        const videoElement = videoRef.current;
        if (videoElement) {
            videoElement.play().catch(e => {
                console.error('[hls] Manual play failed:', e);
            });
        }
    };

    const handleRetry = () => {
        setStreamStatus('loading');
        setRetryCount(0);
        initPlayer();
    };

    useEffect(() => {
        // Start checking for stream after component mounts
        const timeoutId = setTimeout(() => {
            initPlayer();
        }, 1000);

        // Cleanup function
        return () => {
            clearTimeout(timeoutId);
            if (hlsRef.current) {
                console.log('[hls] Destroying HLS.js instance');
                hlsRef.current.destroy();
                hlsRef.current = null;
            }
        };
    }, []);

    // Simulate viewer count (in a real app, this would come from WebSocket or API)
    useEffect(() => {
        if (streamStatus === 'playing') {
            const interval = setInterval(() => {
                setViewerCount(prev => Math.max(1, prev + Math.floor(Math.random() * 3) - 1));
            }, 5000);
            return () => clearInterval(interval);
        }
    }, [streamStatus]);

    const getStatusMessage = () => {
        switch (streamStatus) {
            case 'loading':
                return 'Looking for live stream...';
            case 'no-stream':
                return `No stream detected. Retrying... (${retryCount}/10)`;
            case 'ready':
                return 'Stream ready - Click play to watch';
            case 'playing':
                return 'Live stream playing';
            case 'error':
                return 'Error loading stream';
            default:
                return 'Unknown status';
        }
    };

    const getStatusColor = () => {
        switch (streamStatus) {
            case 'playing':
                return 'text-green-400';
            case 'ready':
                return 'text-blue-400';
            case 'loading':
            case 'no-stream':
                return 'text-yellow-400';
            case 'error':
                return 'text-red-400';
            default:
                return 'text-gray-400';
        }
    };

    return (
        <div className="min-h-screen bg-gray-900 text-white flex flex-col justify-center items-center p-4">
            <h1 className="text-4xl font-bold mb-6">HLS Live Stream</h1>
            
            <div className="w-full max-w-4xl bg-black rounded-lg shadow-2xl overflow-hidden relative">
                <video 
                    ref={videoRef}
                    controls
                    playsInline
                    className="w-full h-full aspect-video bg-black"
                    onPlay={() => setStreamStatus('playing')}
                    onPause={() => console.log('[hls] Video paused')}
                    onError={(e) => {
                        console.error('[hls] Video element error:', e);
                        setStreamStatus('error');
                    }}
                />
                
                {/* Overlay for different states */}
                {streamStatus !== 'playing' && (
                    <div className="absolute inset-0 bg-black bg-opacity-75 flex flex-col items-center justify-center">
                        <div className="text-center">
                            <div className="mb-4">
                                {streamStatus === 'loading' && (
                                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto"></div>
                                )}
                                {streamStatus === 'no-stream' && (
                                    <div className="animate-pulse rounded-full h-12 w-12 bg-yellow-500 mx-auto"></div>
                                )}
                                {streamStatus === 'error' && (
                                    <div className="rounded-full h-12 w-12 bg-red-500 mx-auto flex items-center justify-center">
                                        <span className="text-white font-bold">!</span>
                                    </div>
                                )}
                                {streamStatus === 'ready' && (
                                    <button 
                                        onClick={handlePlayClick}
                                        className="rounded-full h-16 w-16 bg-blue-600 hover:bg-blue-700 mx-auto flex items-center justify-center transition-colors"
                                    >
                                        <span className="text-white text-2xl ml-1">▶</span>
                                    </button>
                                )}
                            </div>
                            
                            <p className={`text-lg mb-4 ${getStatusColor()}`}>
                                {getStatusMessage()}
                            </p>
                            
                            {streamStatus === 'error' && (
                                <button 
                                    onClick={handleRetry}
                                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded transition-colors"
                                >
                                    Retry
                                </button>
                            )}
                            
                            {streamStatus === 'no-stream' && (
                                <p className="text-sm text-gray-400">
                                    Make sure someone is streaming first
                                </p>
                            )}
                        </div>
                    </div>
                )}
            </div>
            
            <div className="mt-4 text-center">
                <p className="text-gray-400">
                    {streamStatus === 'playing' ? 
                        `🔴 LIVE • ${viewerCount} viewer${viewerCount !== 1 ? 's' : ''}` : 
                        'Stream Status: Waiting for broadcast'
                    }
                </p>
                <p className="text-sm text-gray-500 mt-2">
                    There may be a few seconds delay from the live stream
                </p>
            </div>

            {/* Debug info (remove in production) */}
            {process.env.NODE_ENV === 'development' && (
                <div className="mt-4 p-4 bg-gray-800 rounded text-xs max-w-4xl w-full">
                    <h3 className="font-bold mb-2">Debug Info:</h3>
                    <p>Status: {streamStatus}</p>
                    <p>Retry Count: {retryCount}</p>
                    <p>HLS URL: {HLS_STREAM_URL}</p>
                    <p>HLS.js Supported: {Hls.isSupported() ? 'Yes' : 'No'}</p>
                    <p>Native HLS: {videoRef.current?.canPlayType('application/vnd.apple.mpegurl') || 'No'}</p>
                </div>
            )}
        </div>
    );
}