const express = require('express');
const fs = require('fs');
const path = require('path');
const util = require('util');
const readFile = util.promisify(fs.readFile);

// 配置文件路径
const CONFIG_FILE = path.join(__dirname, 'config.json');

// 创建 Express 应用
const app = express();

// 中间件配置
app.use(express.json());
app.use(express.static('public'));

// CORS 支持
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-Admin-Key');
    
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// 检查配置文件目录是否存在
const configDir = path.dirname(CONFIG_FILE);
if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
}

// 默认配置
const defaultConfig = {
    port: 3000,
    adminKey: 'admin', // 默认管理员密钥
    jsdelivr: {
        npm_base: 'https://cdn.jsdelivr.net/npm',
        github_base: 'https://cdn.jsdelivr.net/gh',
        wordpress_base: 'https://cdn.jsdelivr.net/wp',
        whitelist: {
            npm: [],
            github: [],
            wordpress: {
                plugins: [],
                themes: []
            }
        }
    },
    cache: {
        enabled: true,
        duration: 24 * 60 * 60 // 24小时
    }
};

// 全局配置对象
let config = defaultConfig;

// 如果配置文件不存在，创建默认配置
if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
} else {
    // 加载现有配置
    try {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        config = JSON.parse(data);
        console.log('Loaded config:', config);
    } catch (error) {
        console.error('Error loading config:', error);
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    }
}

// 缓存存储
const cache = new Map();

// 保存配置
function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log('Config saved');
        return true;
    } catch (error) {
        console.error('Error saving config:', error);
        return false;
    }
}

// 读取错误页面模板
async function getErrorPage(packageInfo) {
    try {
        let errorHtml = await readFile(path.join(__dirname, 'public/error.html'), 'utf8');
        
        // 获取包类型的中文描述
        let packageType = '';
        switch(packageInfo.type) {
            case 'npm':
                packageType = 'npm 包';
                break;
            case 'github':
                packageType = 'GitHub 仓库';
                break;
            case 'wordpress-plugin':
                packageType = 'WordPress 插件';
                break;
            case 'wordpress-theme':
                packageType = 'WordPress 主题';
                break;
            default:
                packageType = '未知类型';
        }

        // 构建官方 URL
        let officialUrl = '';
        switch(packageInfo.type) {
            case 'npm':
                officialUrl = `https://cdn.jsdelivr.net/npm/${packageInfo.name}`;
                break;
            case 'github':
                officialUrl = `https://cdn.jsdelivr.net/gh/${packageInfo.name}`;
                break;
            case 'wordpress-plugin':
                officialUrl = `https://cdn.jsdelivr.net/wp/plugins/${packageInfo.name}`;
                break;
            case 'wordpress-theme':
                officialUrl = `https://cdn.jsdelivr.net/wp/themes/${packageInfo.name}`;
                break;
        }

        // 替换模板中的占位符
        errorHtml = errorHtml
            .replace('{{packageName}}', packageInfo.name)
            .replace('{{packageType}}', packageType)
            .replace(/{{officialUrl}}/g, officialUrl);

        return errorHtml;
    } catch (error) {
        console.error('Error reading error template:', error);
        return '访问受限：请求的资源不在白名单中。';
    }
}

// 读取400错误页面模板
async function get400ErrorPage() {
    try {
        return await readFile(path.join(__dirname, 'public/400.html'), 'utf8');
    } catch (error) {
        console.error('Error reading 400 error template:', error);
        return '请求无效：无法处理的请求格式。';
    }
}

// 验证管理员密钥中间件
function adminAuth(req, res, next) {
    const providedKey = req.headers['x-admin-key'];
    console.log('Auth check - Provided key:', providedKey);
    console.log('Auth check - Config key:', config.adminKey);

    if (!providedKey || providedKey !== config.adminKey) {
        console.log('Authentication failed');
        res.status(403).json({ error: 'Unauthorized' });
        return;
    }
    next();
}

// 缓存中间件
async function cacheMiddleware(req, res, next) {
    if (!config.cache.enabled) {
        return next();
    }

    const key = req.url;
    const cached = cache.get(key);

    if (cached && Date.now() - cached.timestamp < config.cache.duration * 1000) {
        res.set('Content-Type', cached.contentType);
        res.send(cached.data);
        return;
    }

    next();
}

// 管理员 API 路由
app.post('/api/admin/verify', (req, res) => {
    const providedKey = req.headers['x-admin-key'];
    console.log('Verify - Provided key:', providedKey);
    console.log('Verify - Config key:', config.adminKey);

    if (!providedKey || providedKey !== config.adminKey) {
        console.log('Verification failed');
        res.status(403).json({ 
            error: 'Invalid admin key',
            message: 'The provided admin key is invalid'
        });
        return;
    }

    res.json({ success: true });
});

app.get('/api/admin/config', adminAuth, (req, res) => {
    res.json(config);
});

app.post('/api/admin/whitelist/:type', adminAuth, (req, res) => {
    const { type } = req.params;
    const { items, type: wpType } = req.body;

    if (type === 'wordpress') {
        if (!wpType || !Array.isArray(items)) {
            res.status(400).json({ error: 'Invalid request' });
            return;
        }
        config.jsdelivr.whitelist.wordpress[wpType] = items;
    } else if (type === 'npm' || type === 'github') {
        if (!Array.isArray(items)) {
            res.status(400).json({ error: 'Invalid request' });
            return;
        }
        config.jsdelivr.whitelist[type] = items;
    } else {
        res.status(400).json({ error: 'Invalid type' });
        return;
    }

    if (saveConfig()) {
        res.json({ success: true });
    } else {
        res.status(500).json({ error: 'Failed to save config' });
    }
});

app.post('/api/admin/cache', adminAuth, (req, res) => {
    const { enabled, duration } = req.body;
    config.cache.enabled = enabled;
    if (duration) config.cache.duration = duration;
    
    if (saveConfig()) {
        res.json({ success: true });
    } else {
        res.status(500).json({ error: 'Failed to save cache settings' });
    }
});

app.post('/api/admin/cache/clear', adminAuth, (req, res) => {
    cache.clear();
    res.json({ success: true });
});

app.get('/api/admin/cache/stats', adminAuth, (req, res) => {
    let totalSize = 0;
    for (const [_, value] of cache) {
        // 检查 data 是否为 Buffer
        if (Buffer.isBuffer(value.data)) {
            totalSize += value.data.length;
        } else if (typeof value.data === 'string') {
            totalSize += Buffer.byteLength(value.data);
        } else {
            // 如果是其他类型,尝试转换为字符串再计算
            totalSize += Buffer.byteLength(String(value.data));
        }
    }
    
    // 转换为更易读的格式
    const formatSize = (bytes) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    };
    
    const stats = {
        itemCount: cache.size,
        totalSize: formatSize(totalSize)
    };
    
    res.json(stats);
});

app.post('/api/admin/settings', adminAuth, (req, res) => {
    const { adminKey: newAdminKey, port } = req.body;
    let needsRestart = false;

    if (newAdminKey) {
        config.adminKey = newAdminKey;
    }
    
    if (port && port !== config.port) {
        config.port = port;
        needsRestart = true;
    }

    if (saveConfig()) {
        res.json({ success: true, needsRestart });
    } else {
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// 代理请求处理
app.use(cacheMiddleware, async (req, res) => {
    const url = req.url;
    let packageType, packageName, baseUrl, proxyUrl;

    // 解析请求类型和包名
    if (url.startsWith('/npm/')) {
        packageType = 'npm';
        // 提取@符号或第一个/之前的包名
        packageName = url.slice(5).split(/[@/]/)[0];
        baseUrl = config.jsdelivr.npm_base;
        // 保持原始路径，但移除开头的 /npm
        proxyUrl = baseUrl + url.slice(4);
    } else if (url.startsWith('/gh/')) {
        packageType = 'github';
        // 提取owner/repo格式,忽略版本号和路径
        const parts = url.slice(4).split('@')[0].split('/');
        packageName = parts.slice(0, 2).join('/');
        baseUrl = config.jsdelivr.github_base;
        // 保持原始路径，但移除开头的 /gh
        proxyUrl = baseUrl + url.slice(3);
    } else if (url.startsWith('/wp/')) {
        const parts = url.slice(4).split('/');
        if (parts[0] === 'plugins' || parts[0] === 'themes') {
            packageType = 'wordpress-' + parts[0].slice(0, -1);
            // 提取干净的包名(去除版本号)
            packageName = parts[1].split('@')[0];
            baseUrl = config.jsdelivr.wordpress_base;
            // 保持原始路径，但移除开头的 /wp
            proxyUrl = baseUrl + url.slice(3);
        }
    }

    // 400错误处理
    if (!packageType || !packageName) {
        const errorHtml = await get400ErrorPage();
        res.status(400).send(errorHtml);
        return;
    }

    // 检查白名单
    let isInWhitelist = false;
    if (packageType === 'npm') {
        isInWhitelist = config.jsdelivr.whitelist.npm.includes(packageName);
    } else if (packageType === 'github') {
        isInWhitelist = config.jsdelivr.whitelist.github.includes(packageName);
    } else if (packageType === 'wordpress-plugin') {
        isInWhitelist = config.jsdelivr.whitelist.wordpress.plugins.includes(packageName);
    } else if (packageType === 'wordpress-theme') {
        isInWhitelist = config.jsdelivr.whitelist.wordpress.themes.includes(packageName);
    }

    if (!isInWhitelist) {
        const errorHtml = await getErrorPage({
            name: packageName,
            type: packageType
        });
        res.status(403).send(errorHtml);
        return;
    }

    try {
        console.log('Proxying request to:', proxyUrl); // 添加日志
        const response = await fetch(proxyUrl);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const contentType = response.headers.get('content-type');
        const data = Buffer.from(await response.arrayBuffer());

        if (config.cache.enabled) {
            cache.set(url, {
                data,
                contentType,
                timestamp: Date.now()
            });
        }

        res.set('Content-Type', contentType);
        res.send(data);
    } catch (error) {
        console.error('Proxy error:', error);
        console.error('Request URL:', proxyUrl); // 添加错误日志
        const errorHtml = await get400ErrorPage();
        res.status(500).send(errorHtml);
        return;
    }
});

// 错误处理中间件
app.use(async (err, req, res, next) => {
    console.error('Error:', err);
    
    if (err.status === 400 || err.statusCode === 400) {
        const errorHtml = await get400ErrorPage();
        res.status(400).send(errorHtml);
        return;
    }
    
    res.status(500).json({ 
        error: 'Internal server error',
        message: err.message 
    });
});

// 启动服务器
const server = app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
});

// 优雅关闭
process.on('SIGTERM', () => {
    server.close(() => {
        console.log('Server shutdown complete');
        process.exit(0);
    });
});