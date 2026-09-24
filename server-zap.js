require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pino = require('pino');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3001;
const ZAP_SECRET = process.env.ZAP_SECRET || '5800991m@Mm12345';
const authPath = path.join(__dirname, 'sessao_zap');

let sock = null;
let qrCodeData = null;

// Middleware de Segurança
const verifyToken = (req, res, next) => {
    const bearerHeader = req.headers['authorization'];
    if (bearerHeader && bearerHeader.split(' ')[1] === ZAP_SECRET) {
        next();
    } else {
        res.status(403).json({ error: 'Acesso negado. Token inválido.' });
    }
};

async function iniciarZap() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version } = await fetchLatestBaileysVersion();

        console.log(`📡 Conectando WhatsApp v${version.join('.')}`);

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,      // 60 segundos de tolerância contra Status 408 no Render
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            syncFullHistory: false,
            markOnlineOnConnect: true
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log("⚡ QR Code gerado com sucesso!");
                qrCodeData = await qrcode.toDataURL(qr);
            }

            if (connection === 'close') {
                const status = lastDisconnect?.error?.output?.statusCode;
                console.log(`⚠️ Conexão perdida (Status: ${status || 'desconhecido'}). Reconectando...`);
                qrCodeData = null;
                
                // Se a sessão for revogada ou expirada, limpa as credenciais
                const sessaoInvalida = [401, 403, 405, DisconnectReason.loggedOut].includes(status);
                if (sessaoInvalida) {
                    console.log("❌ Sessão inválida. Limpando credenciais...");
                    if (fs.existsSync(authPath)) {
                        fs.rmSync(authPath, { recursive: true, force: true });
                    }
                }
                
                sock = null;
                setTimeout(iniciarZap, 5000);
            } else if (connection === 'open') {
                console.log('✅ SISTEMA ZAP ONLINE E PRONTO NO RENDER!');
                qrCodeData = null;
            }
        });
    } catch (err) {
        console.error("❌ Erro ao inicializar o Baileys:", err.message);
        setTimeout(iniciarZap, 5000);
    }
}

// ROTA: Enviar Mensagem
app.post('/api/enviar', verifyToken, async (req, res) => {
    if (!sock || !sock.user) return res.status(503).json({ status: 'offline', error: 'WhatsApp offline' });

    const { numero, arquivoBase64, tipo, texto, fileName, legenda, mimetype } = req.body;
    const numLimpo = numero.replace(/\D/g, '');
    const jid = `${numLimpo}@s.whatsapp.net`;

    try {
        if (tipo === 'documento' && arquivoBase64) {
            const buffer = Buffer.from(arquivoBase64, 'base64');
            await sock.sendMessage(jid, { 
                document: buffer, 
                mimetype: mimetype || 'application/pdf', 
                fileName: fileName || 'Documento.pdf', 
                caption: legenda || '' 
            });
        } else if (tipo === 'texto') {
            await sock.sendMessage(jid, { text: texto });
        }
        res.json({ success: true, status: 'sent' });
    } catch (e) {
        console.error("Erro no envio:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ROTA: Checar Status e Pegar QR Code
app.get('/api/status', verifyToken, (req, res) => {
    if (sock && sock.user) return res.json({ status: 'online' });
    if (qrCodeData) return res.json({ status: 'aguardando_qr', qr: qrCodeData });
    res.json({ status: 'inicializando' });
});

app.listen(PORT, () => {
    console.log(`🚀 Microserviço do WhatsApp rodando na porta ${PORT}`);
    iniciarZap();
});