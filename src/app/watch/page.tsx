'use client';

import Hls from "hls.js";
import { useEffect, useRef } from "react";

const HLS_STREAM_URL = '/hls/stream.m3u8';

export default function WatchPage() {
    const videoRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<Hls| null>(null);

    useEffect(() => {
        const videoElement = videoRef.current;
        if (!videoElement) return;

        const initPlayer = () => {
            if (Hls.isSupported()) {
                console.log(`[hls.js] Initializing HLS.js Player`);
                const hls = new Hls({
                    maxBufferLength : 30,
                    maxMaxBufferLength : 60,
                });
                hlsRef.current = hls;
                hls.loadSource(HLS_STREAM_URL);
                hls.attachMedia(videoElement);
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    console.log(`[hls.js] Manifest parsed, playing video.`);
                    videoElement.play().catch(e => console.error('Autoplay has prevented : ', e));
                });
                hls.on(Hls.Events.ERROR, (event, data) => {
                    if (data.fatal) {
                        switch (data.type) {
                            case Hls.ErrorTypes.NETWORK_ERROR:
                                console.log(`[hls.js] Fatal network error, trying to recover...`, data);
                                hls.startLoad();
                                break;
                            case Hls.ErrorTypes.MEDIA_ERROR:
                                console.log(`[hls.js] Fatal media error, trying to recover...`, data);
                                hls.recoverMediaError();
                                break;
                            default:
                                console.error(`[hls.js] Unrecoverable fatal error`, data);
                                hls.destroy();
                                break;
                        }
                    }
                });
            } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
                console.log(`[hls.js] Using native hls support`);
                videoElement.src = HLS_STREAM_URL;
                videoElement.addEventListener('loadedmetadata', () => {
                    videoElement.play().catch(e => console.error('autoplay was prevented:', e));
                });
            }
        };
        // Use a timeout to wait for the stream to be available
        // In a real app, you might use a WebSocket message or API call to check stream status
        const timeoutId = setTimeout(initPlayer, 2000); // Wait 2 seconds

        // Cleanup function
        return () => {
            clearTimeout(timeoutId);
            if (hlsRef.current) {
                console.log('[hls.js] Destroying HLS.js instance.');
                hlsRef.current.destroy();
            }
        };
    }, []);

    return (
        <div className="min-h-screen bg-gray-900 text-white flex flex-col justify-center items-center p-4">
            <h1 className="text-4xl font-bold mb-6">HLS Live Playback</h1>
            <div className="w-full max-w-4xl bg-black rounded-lg shadow-2xl overflow-hidden">
                <video 
                    ref={videoRef}
                    controls
                    autoPlay
                    muted
                    className="w-full h-full aspect-video"    
                ></video>
            </div>
            <p className="mt-4 text-gray-400">You are watching the live broadcast. There will be a delay from the real time stream.</p>
        </div>
    )
}