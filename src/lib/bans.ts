import axios, { AxiosError } from 'axios';
import { BPTFGetUserInfo } from '../classes/MyHandler/interfaces';
import log from '../lib/logger';
import filterAxiosError from '@tf2autobot/filter-axios-error';
import Bot from '../classes/Bot';
import { ReputationCheck } from '../classes/Options';
import { LeveledLogMethod } from 'winston';
import { axiosAbortSignal } from './helpers';

export type Contents = { [website: string]: string };
export interface IsBanned {
    isBanned: boolean;
    contents?: Contents;
}

interface SiteResult {
    isBanned: boolean;
    content?: string;
}

interface BansEntry {
    bot: Bot;
    userID?: string;
    steamID: string;
    showLog?: 'all' | 'banned';
}

export interface ResultSources {
    bptf?: SiteResult;
    mptf?: SiteResult;
    steamrep?: SiteResult;
    untrusted?: SiteResult;
}

type Sites = 'TF2Autobot' | 'Marketplace.tf' | 'Backpack.tf' | 'Steamrep.com';

interface RepAutobotTfContents {
    TF2Autobot: SiteResult | 'Error';
    'Marketplace.tf': SiteResult | 'Error';
    'Backpack.tf': SiteResult | 'Error';
    'Steamrep.com': SiteResult | 'Error';
}

interface RepAutobotTf {
    isBanned: boolean;
    contents: RepAutobotTfContents;
    isBannedExcludeMptf: boolean;
    obtained_time: number;
    last_update: number;
    with_error: boolean;
}

export default class Bans {
    private _isBptfBanned: boolean = null;

    private _isBptfSteamRepBanned: boolean = null;

    private _isSteamRepBanned: boolean = null;

    private _isCommunityBanned: boolean = null;

    private _isMptfBanned: boolean = null;

    private readonly bot: Bot;

    private readonly userID?: string;

    private readonly steamID: string;

    private readonly showLog: 'all' | 'banned';

    constructor({ bot, userID, steamID, showLog = 'all' }: BansEntry) {
        this.showLog = showLog;
        this.steamID = steamID;
        this.userID = userID;
        this.bot = bot;
    }

    private get repOpt(): ReputationCheck {
        return this.bot.options.miscSettings.reputationCheck;
    }

    async isBanned(): Promise<IsBanned> {
        try {
            const fromRepAutobot = await this.resultsFromAutobot();
            const isBanned = this.repOpt.checkMptfBanned ? fromRepAutobot.isBanned : fromRepAutobot.isBannedExcludeMptf;
            const contents = Object.keys(fromRepAutobot.contents).reduce((obj, site) => {
                if (
                    fromRepAutobot.contents[site as Sites] !== 'Error' &&
                    (fromRepAutobot.contents[site as Sites] as SiteResult)?.isBanned // can also be null
                ) {
                    obj[site] = (fromRepAutobot.contents[site as Sites] as SiteResult).content;
                }
                return obj;
            }, {}) as Contents;

            return {
                isBanned,
                contents
            };
        } catch {
            // always deny by default
            let result: IsBanned = {
                isBanned: true,
                contents: {
                    'default-rule': 'all offline and online ban checks failed. internet issues?'
                }
            };
            const finalize = (results: ResultSources): IsBanned => {
                const { bptf, mptf, steamrep, untrusted } = results;
                const validResults = [bptf, mptf, steamrep, untrusted].filter(r => !!r);
                const haveResults = validResults.length > 0;
                if (haveResults) {
                    result = {
                        isBanned: validResults.some(r => r.isBanned),
                        contents: {}
                    };

                    if (bptf) {
                        result.contents['Backpack.tf'] = bptf.isBanned
                            ? `banned${bptf.content !== '' ? ` - ${bptf.content}` : ''}`
                            : 'clean';
                    }

                    if (this.repOpt.checkMptfBanned && mptf) {
                        result.contents['Marketplace.tf'] = mptf.isBanned
                            ? `banned${mptf.content !== '' ? ` - ${mptf.content}` : ''}`
                            : 'clean';
                    }

                    if (untrusted) {
                        result.contents['TF2Autobot'] = untrusted.isBanned
                            ? `banned${untrusted.content !== '' ? ` - ${untrusted.content}` : ''}`
                            : 'clean';
                    }

                    if (steamrep) {
                        result.contents['Steamrep.com:'] = steamrep.isBanned
                            ? `banned${steamrep.content !== '' ? ` - ${steamrep.content}` : ''}`
                            : 'clean';
                    }
                }
                this.logIsBanned(result);
                return result;
            };

            // Else if rep.tf is not as primary, check from each website first
            return await Promise.all([
                this.isListedUntrusted(),
                this.isMptfBanned(),
                this.isSteamRepMarked(),
                this.isBptfBanned()
            ])
                .then(([untrusted, mptf, steamrep, bptf]) => {
                    // If all success, proceed
                    return finalize({ bptf, mptf, steamrep, untrusted });
                })
                .catch(err => {
                    // Else if an error occurred, check if all cache say you are okay
                    if (
                        ![
                            this._isBptfBanned,
                            this._isBptfSteamRepBanned,
                            this._isSteamRepBanned,
                            this._isCommunityBanned,
                            this.repOpt.checkMptfBanned && this._isMptfBanned
                        ].some(b => b)
                    ) {
                        return { isBanned: false };
                    }

                    // else throw error
                    throw err;
                });
        }
    }

    /** may or may not print results depending on showLog setting and ban result */
    private logIsBanned(result: IsBanned) {
        if (this.showLog) {
            let _log: LeveledLogMethod;
            if (result.isBanned) {
                _log = log['warn'];
            } else if (this.showLog === 'all') {
                _log = log['debug'];
            }
            if (_log) {
                _log(`Bans result for ${this.steamID}:`, result.contents);
            }
        }
    }

    private resultsFromAutobot(): Promise<RepAutobotTf> {
        return new Promise((resolve, reject) => {
            axios({
                method: 'GET',
                url: `https://rep.autobot.tf/json/${this.steamID}`,
                params: {
                    checkMptf: this.repOpt.checkMptfBanned
                }
            })
                .then(res => {
                    return resolve(res.data as RepAutobotTf);
                })
                .catch(err => {
                    return reject(err);
                });
        });
    }

    private isBptfBanned(): Promise<SiteResult | undefined> {
        if (!this.bot.options.bptfApiKey) {
            return;
        }
        return new Promise(resolve => {
            void axios({
                url: 'https://api.backpack.tf/api/users/info/v1',
                headers: {
                    'User-Agent': 'TF2Autobot@' + process.env.BOT_VERSION,
                    Cookie: 'user-id=' + this.userID
                },
                params: {
                    key: this.bot.options.bptfApiKey,
                    steamids: this.steamID
                }
            })
                .then(response => {
                    const user = (response.data as BPTFGetUserInfo).users[this.steamID];
                    const isBptfBanned =
                        user.bans && (user.bans.all !== undefined || user.bans['all features'] !== undefined);

                    const banReason = user.bans ? user.bans.all?.reason ?? user.bans['all features']?.reason ?? '' : '';

                    this._isBptfBanned = isBptfBanned;
                    this._isBptfSteamRepBanned = user.bans ? user.bans.steamrep_scammer === 1 : false;

                    return resolve({ isBanned: isBptfBanned, content: banReason });
                })
                .catch((err: AxiosError) => {
                    if (err) {
                        if (this.showLog) {
                            log.warn('Failed to get data from backpack.tf');
                            log.debug(filterAxiosError(err));
                        }
                        return resolve(undefined);
                    }
                });
        });
    }

    private isSteamRepMarked(): Promise<SiteResult | undefined> {
        return new Promise(resolve => {
            void axios({
                url: 'https://steamrep.com/api/beta4/reputation/' + this.steamID,
                params: {
                    json: 1
                }
            })
                .then(response => {
                    const isSteamRepBanned =
                        (response.data as SteamRep).steamrep.reputation?.summary.toLowerCase().indexOf('scammer') !==
                        -1;
                    const fullRepInfo = (response.data as SteamRep).steamrep.reputation?.full ?? '';

                    this._isSteamRepBanned = isSteamRepBanned;
                    return resolve({ isBanned: isSteamRepBanned, content: fullRepInfo });
                })
                .catch((err: AxiosError) => {
                    if (err) {
                        if (this.showLog) {
                            log.warn('Failed to get data from SteamRep');
                            log.debug(filterAxiosError(err));
                        }
                        if (this._isBptfSteamRepBanned !== null) {
                            return resolve({ isBanned: this._isBptfSteamRepBanned });
                        }
                        return resolve(undefined);
                    }
                });
        });
    }

    private isMptfBanned(): Promise<SiteResult | undefined> {
        return new Promise((resolve, reject) => {
            if (!this.repOpt.checkMptfBanned) {
                return resolve(undefined);
            }

            if (this.bot.options.mptfApiKey === '') {
                return reject(new Error('Marketplace.tf API key was not set.'));
            }

            void axios({
                method: 'POST',
                url: 'https://marketplace.tf/api/Bans/GetUserBan/v2',
                headers: {
                    'User-Agent': 'TF2Autobot@' + process.env.BOT_VERSION
                },
                params: {
                    key: this.bot.options.mptfApiKey,
                    steamid: this.steamID
                }
            })
                .then(response => {
                    const results = (response.data as MptfGetUserBan)?.results;

                    if (!Array.isArray(results)) {
                        log.debug('Marketplace.tf returned invalid data', results);
                        return resolve(undefined);
                    }

                    const resultSize = results.length;
                    for (let i = 0; i < resultSize; i++) {
                        if (this.steamID === results[i].steamid) {
                            this._isMptfBanned = results[i].banned ?? false;

                            return resolve({
                                isBanned: results[i].banned ?? false,
                                content: results[i].ban?.type ?? ''
                            });
                        }
                    }

                    return resolve({ isBanned: false });
                })
                .catch((err: AxiosError) => {
                    if (err) {
                        if (this.showLog) log.warn('Failed to get data from Marketplace.tf', err);
                        return resolve(undefined);
                    }
                });
        });
    }

    private isListedUntrusted(attempt: 'first' | 'retry' = 'first'): Promise<SiteResult | undefined> {
        return new Promise(resolve => {
            void axios({
                method: 'GET',
                url: 'https://raw.githubusercontent.com/TF2Autobot/untrusted-steam-ids/master/untrusted.min.json',
                signal: axiosAbortSignal(60000)
            })
                .then(response => {
                    const results = (response.data as UntrustedJson).steamids[this.steamID];

                    if (results === undefined) {
                        return resolve({ isBanned: false });
                    }

                    this._isCommunityBanned = true;
                    return resolve({
                        isBanned: true,
                        content: `Reason: ${results.reason} - Source: ${results.source}`
                    });
                })
                .catch((err: AxiosError) => {
                    if (err instanceof AbortSignal && attempt !== 'retry') {
                        return this.isListedUntrusted('retry');
                    }
                    if (err) {
                        if (this.showLog) {
                            log.warn('Failed to get data from Github');
                            log.debug(err instanceof AxiosError ? filterAxiosError(err) : err);
                        }
                    }
                    resolve(undefined);
                });
        });
    }
}

export function isBptfBanned(steamID: string, bptfApiKey: string, userID: string, showLog = true): Promise<SiteResult> {
    return new Promise((resolve, reject) => {
        void axios({
            url: 'https://api.backpack.tf/api/users/info/v1',
            headers: {
                'User-Agent': 'TF2Autobot@' + process.env.BOT_VERSION,
                Cookie: 'user-id=' + userID
            },
            params: {
                key: bptfApiKey,
                steamids: steamID
            }
        })
            .then(response => {
                const user = (response.data as BPTFGetUserInfo).users[steamID];
                const isBptfBanned =
                    user.bans && (user.bans.all !== undefined || user.bans['all features'] !== undefined);

                const banReason = user.bans ? user.bans.all?.reason ?? user.bans['all features']?.reason ?? '' : '';

                return resolve({ isBanned: isBptfBanned, content: banReason });
            })
            .catch((err: AxiosError) => {
                if (err) {
                    if (showLog) log.warn('Failed to get data from backpack.tf');
                    return reject(filterAxiosError(err));
                }
            });
    });
}

interface MptfGetUserBan {
    success: boolean;
    results: MptfResult[];
}

interface MptfResult {
    steamid: string;
    id: number;
    name: string;
    banned: boolean;
    ban?: MptfBan;
    seller: boolean;
}

interface MptfBan {
    time: number;
    type: string;
}

interface SteamRep {
    steamrep: Details;
}

interface Details {
    flags: Flags;
    steamID32?: string;
    steamID64?: string;
    steamrepurl?: string;
    reputation?: Reputation;
}

interface Flags {
    status: string;
}

interface Reputation {
    full?: string;
    summary?: string;
}

interface UntrustedJson {
    last_update: number;
    steamids: UntrustedJsonSteamids;
}

interface UntrustedJsonSteamids {
    [steamID: string]: UntrustedJsonSteamidsContent;
}

interface UntrustedJsonSteamidsContent {
    reason: string;
    source: string;
    time: number;
}
