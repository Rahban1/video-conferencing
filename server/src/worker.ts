import * as mediasoup from 'mediasoup';
import { config } from './config';

let worker: mediasoup.types.Worker;
let router: mediasoup.types.Router;

export const startMediaSoup = async () => {
    console.log('[mediasoup] starting mediasoup worker');

    worker = await mediasoup.createWorker({
        logLevel : config.mediasoup.workerSettings.logLevel,
        logTags : config.mediasoup.workerSettings.logTags.slice(), // this expects a mutable array and we are giving a read only so that is why we gave a shallow copy using .slice(), we could have also used [...array] to fix it (same concept of giving a shallow copy to it, if it needs to mutate it later)
        rtcMinPort : config.mediasoup.workerSettings.rtcMinPort,
        rtcMaxPort : config.mediasoup.workerSettings.rtcMaxPort
    });

    worker.on('died', () => {
        console.error(`[mediasoup] Worker has died. Exiting...`);
        process.exit(1);
    })

    console.log(`[mediasoup] worker started with pid ${worker.pid}`);

    router = await worker.createRouter({
        mediaCodecs : config.mediasoup.router.mediaCodecs,
    });

    console.log(`[mediasoup] Router created`);
    return { worker, router }; 
};

export const getRouter = () => {
    if (!router) {
        throw new Error('MediaSoup router not initialized');
    }
    return router;
}