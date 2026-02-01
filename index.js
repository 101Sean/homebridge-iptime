const http = require('http');
const https = require('https');
const { URL } = require('url');

let Service, Characteristic, uuid, tlv;

module.exports = api => {
    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;
    uuid = api.hap.uuid;
    tlv = api.hap.tlv;
    api.registerPlatform('IpTimeMasterControl', 'IpTimeMasterControl', IpTimeMasterPlatform);
};

class IpTimeMasterPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.sessionId = null;
        this.isOnline = false;

        this.api.on('didFinishLaunching', () => {
            this.setupRouterAccessory();
            this.updateStatus();
            setInterval(() => this.updateStatus(), (config.interval || 5) * 60 * 1000);
        });
    }

    httpRequest(options, body = '') {
        options.insecureHTTPParser = true;
        const lib = options.protocol === 'https:' ? https : http;
        return new Promise((resolve, reject) => {
            const req = lib.request(options, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ body: data }));
            });
            req.on('error', err => reject(err));
            if (body) req.write(body);
            req.end();
        });
    }

    async login() {
        try {
            const url = new URL(this.config.url);
            const loginBody = new URLSearchParams({
                username: this.config.username, passwd: this.config.password,
                init_status: 1, captcha_on: 0, default_passwd: 'admin',
                Referer: `${url.origin}/sess-bin/login_session.cgi?noauto=1`
            }).toString();
            const resp = await this.httpRequest({
                protocol: url.protocol, hostname: url.hostname, port: url.port,
                method: 'POST', path: '/sess-bin/login_handler.cgi',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            }, loginBody);
            const match = resp.body.match(/setCookie\('([^']+)'\)/);
            if (match) { this.sessionId = match[1].trim(); return true; }
        } catch (e) { return false; }
        return false;
    }

    setupRouterAccessory() {
        const accessoryUuid = uuid.generate('iptime-router-main');
        const accessory = new this.api.platformAccessory(this.config.name || 'ipTIME Router', accessoryUuid);

        accessory.category = 33;
        const infoService = accessory.getService(Service.AccessoryInformation);
        infoService
            .setCharacteristic(Characteristic.Manufacturer, 'ipTIME')
            .setCharacteristic(Characteristic.Model, 'AX2004')
            .setCharacteristic(Characteristic.SerialNumber, 'IPTIME-HOMEBRIDGE-01')
            .setCharacteristic(Characteristic.FirmwareRevision, '14.29.2');

        this.routerService = accessory.getService(Service.WiFiRouter) || accessory.addService(Service.WiFiRouter, this.config.name);

        this.routerService.getCharacteristic(Characteristic.ConfiguredName)
            .onGet(() => this.config.name || 'ipTIME Router');

        this.routerService.getCharacteristic(Characteristic.ManagedNetworkEnable)
            .onGet(() => tlv.encode(0x01, 1).toString('base64'));

        this.routerService.getCharacteristic(Characteristic.RouterStatus)
            .onGet(() => (this.isOnline ? 0 : 1));

        const rebootService = accessory.getService("Reboot") || accessory.addService(Service.Switch, "Reboot", 'reboot-btn');
        rebootService.getCharacteristic(Characteristic.On).onSet(async (v) => {
            if (v) {
                this.log.warn('⚠️ 재부팅 명령 전송');
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
                protocol: url.protocol, hostname: url.hostname, port: url.port,
                method: 'GET', path: '/sess-bin/timepro.cgi?tmenu=iframe&smenu=system_info_status',
                headers: { 'Cookie': `efm_session_id=${this.sessionId}` }
            });
            this.isOnline = resp.body.includes('연결됨') || !resp.body.includes('0.0.0.0');
            this.routerService.updateCharacteristic(Characteristic.RouterStatus, this.isOnline ? 0 : 1);
            this.log.info(`📊 온라인 여부: ${this.isOnline}`);
        } catch (e) {
            this.sessionId = null;
            this.isOnline = false;
        }
    }

    async executeReboot() {
        try {
            const url = new URL(this.config.url);
            const body = new URLSearchParams({ tmenu: 'iframe', smenu: 'sysconf_misc', act: 'restart', service: 'restart', restarth: '1' }).toString();
            await this.httpRequest({
                protocol: url.protocol, hostname: url.hostname, port: url.port,
                method: 'POST', path: '/sess-bin/timepro.cgi',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Cookie': `efm_session_id=${this.sessionId}`,
                    'Referer': `${url.origin}/sess-bin/timepro.cgi?tmenu=iframe&smenu=sysconf_misc`
                }
            }, body);
        } catch (e) { this.log.error('💻 재부팅 명령 전송 실패'); }
    }
}