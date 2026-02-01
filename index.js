const http = require('http');
const https = require('https');
const { URL } = require('url');

let Service, Characteristic, UUID;

module.exports = api => {
    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;
    UUID = api.hap.uuid;
    api.registerPlatform('IpTimeMasterControl', 'IpTimeMasterControl', IpTimeMasterPlatform);
};

class IpTimeMasterPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.sessionId = null;

        this.refreshIntervalMin = config.interval || 5;
        this.refreshIntervalMs = this.refreshIntervalMin * 60 * 1000;

        this.api.on('didFinishLaunching', () => {
            this.log.info(`🚀 Router 모니터링 시작 (주기: ${this.refreshIntervalMin}분)`);
            this.setupRouterAccessory();
            this.updateStatus();
            setInterval(() => this.updateStatus(), this.refreshIntervalMs);
        });
    }

    httpRequest(options, body = '') {
        options.insecureHTTPParser = true;
        const lib = options.protocol === 'https:' ? https : http;
        return new Promise((resolve, reject) => {
            const req = lib.request(options, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
            });
            req.on('error', err => reject(err));
            if (body) req.write(body);
            req.end();
        });
    }

    async login() {
        try {
            const { url: domain, username, password } = this.config;
            const url = new URL(domain);
            const origin = url.origin;
            const host = url.host;

            const loginPath = `/sess-bin/login_handler.cgi`;
            const loginBody = new URLSearchParams({
                username: username,
                passwd: password,
                init_status: 1,
                captcha_on: 0,
                default_passwd: 'admin',
                Referer: `${origin}/sess-bin/login_session.cgi?noauto=1`
            }).toString();

            const resp = await this.httpRequest({
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                method: 'POST',
                path: loginPath,
                headers: {
                    'Accept': 'text/html',
                    'Host': host,
                    'Connection': 'close',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(loginBody)
                }
            }, loginBody);

            const match = resp.body.match(/setCookie\('([^']+)'\)/);
            if (match) {
                this.sessionId = match[1].trim();
                this.log.info(`🔑 세션 획득 성공: ${this.sessionId}`);
                return true;
            }
            throw new Error('setCookie를 찾을 수 없음');
        } catch (e) {
            this.log.error(`❌ 로그인 실패: ${e.message}`);
            return false;
        }
    }

    setupRouterAccessory() {
        const uuid = UUID.generate('iptime-router-main');
        const accessory = new this.api.platformAccessory(this.config.name || 'iptime 공유기', uuid);

        this.routerService = accessory.addService(Service.ROUTER, this.config.name);

        const rebootService = accessory.addService(Service.Switch, "Reboot", 'reboot-btn');
        rebootService.getCharacteristic(Characteristic.On)
            .onSet(async (value) => {
                if (value) {
                    this.log.warn('⚠️ 공유기 재부팅 실행');
                    await this.executeReboot();
                    setTimeout(() => rebootService.updateCharacteristic(Characteristic.On, false), 2000);
                }
            });

        this.api.registerPlatformAccessories('IpTimeMasterControl', 'IpTimeMasterControl', [accessory]);
    }

    async updateStatus() {
        try {
            if (!this.sessionId) await this.login();
            const url = new URL(this.config.url);

            const resp = await this.httpRequest({
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port,
                method: 'GET',
                path: '/sess-bin/timepro.cgi?tmenu=iframe&smenu=system_info_status',
                headers: {
                    'Cookie': `efm_session_id=${this.sessionId}`,
                    'Host': url.host
                }
            });

            const isOnline = resp.body.includes('연결됨') || !resp.body.includes('0.0.0.0');
            this.routerService.updateCharacteristic(Characteristic.StatusActive, isOnline);
            this.log.info(`📊 공유기 상태 업데이트: ${isOnline ? '온라인' : '오프라인'}`);

        } catch (e) {
            this.log.error('🔄 상태 체크 실패, 세션 초기화');
            this.sessionId = null;
            this.routerService.updateCharacteristic(Characteristic.StatusActive, false);
        }
    }

    async executeReboot() {
        try {
            const url = new URL(this.config.url);

            const params = {
                tmenu: 'iframe',
                smenu: 'sysconf_misc',
                act: "restart",
                service: "restart",
                restarth: 1
            };

            const body = new URLSearchParams(params).toString();

            await this.httpRequest({
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port,
                method: 'POST',
                path: '/sess-bin/timepro.cgi',
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': `efm_session_id=${this.sessionId}`,
                    'Host': url.host,
                    'Referer': `${url.origin}/sess-bin/timepro.cgi?tmenu=iframe&smenu=sysconf_misc`,
                    'Connection': 'keep-alive'
                }
            }, body);

        } catch (e) {
            this.log.error('💻 재부팅 명령 전송 실패:', e.message);
        }
    }
}