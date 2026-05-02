import PopCore from '@alicloud/pop-core';

function normalizeTags(tags) {
  return tags.map((tag) => {
    const [key, ...rest] = tag.split(':');
    return { key, value: rest.join(':') };
  }).filter((tag) => tag.key && tag.value);
}

export class AliyunPop {
  constructor(config) {
    this.config = config;
    this.clients = new Map();
  }

  client(product, endpoint, apiVersion) {
    const key = `${product}:${endpoint}:${apiVersion}`;
    if (!this.clients.has(key)) {
      this.clients.set(key, new PopCore({
        accessKeyId: this.config.aliyun.accessKeyId,
        accessKeySecret: this.config.aliyun.accessKeySecret,
        endpoint,
        apiVersion,
      }));
    }
    return this.clients.get(key);
  }

  async request(product, endpoint, apiVersion, action, params = {}) {
    const client = this.client(product, endpoint, apiVersion);
    return client.request(action, params, { method: 'POST' });
  }

  eci(action, params = {}) {
    return this.request(
      'eci',
      `https://eci.${this.config.aliyun.regionId}.aliyuncs.com`,
      '2018-08-08',
      action,
      { RegionId: this.config.aliyun.regionId, ...params },
    );
  }

  ecs(action, params = {}) {
    return this.request(
      'ecs',
      `https://ecs.${this.config.aliyun.regionId}.aliyuncs.com`,
      '2014-05-26',
      action,
      { RegionId: this.config.aliyun.regionId, ...params },
    );
  }

  tags(prefix = 'Tag') {
    const tags = normalizeTags(this.config.aliyun.tags);
    return Object.fromEntries(tags.flatMap((tag, index) => {
      const n = index + 1;
      return [
        [`${prefix}.${n}.Key`, tag.key],
        [`${prefix}.${n}.Value`, tag.value],
      ];
    }));
  }
}
