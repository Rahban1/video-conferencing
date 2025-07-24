export const config = {
    //server config
    listenIp : '0.0.0.0',
    listenPort : 3001,

    //mediasoup config
    mediasoup : {
        numWorkers : 1,
        workerSettings : {
            logLevel : 'debug',
            logTags : [
                'info',
                'ice',
                'dtls',
                'rtp',
                'srtp',
                'rtcp'
            ],
            rtcMinPort : 10000,
            rtcMaxPort : 10100,
        },
        router : {
            mediaCodecs : [
                {
                    kind : 'audio',
                    mimeType : 'audio/opus',
                    clockRate : 48000,
                    channels : 2,
                },
                {
                    kind : 'video',
                    mimeType : 'video/VP8',
                    clockRate : 90000,
                    parameters : {
                        'x-google-start-bitrate' : 1000,
                    },
                },
            ],
        },
        webRtcTransport : {
            listenIps : [
                {
                    ip : '127.0.0.1' // will use public ip for prod
                },
            ],
            enableUdp : true,
            enableTcp : true,
            preferUdp : true
        },       
    },
} as const;