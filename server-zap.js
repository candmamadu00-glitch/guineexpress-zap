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
const ZAP_SECRET = process.env.ZAP_SECRET || 'sua_senha_inquebravel_aqui_12345';
const authPath = path.join(__dirname, 'sessao_zap');

let sock = null;
let qrCodeData = null;

// Middleware de Segurança Blindada
const verifyToken = (req, res, next) => {
    const bearerHeader = req.headers['authorization'];
    if (bearerHeader && bearerHeader.split(' ')[1] === ZAP_SECRET) {
        next();
    } else {
        res.status(403).json({ error: 'Acesso negado. Token inválido.' });
    }
};

async function iniciarZap() {
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`📡 Conectando WhatsApp v${version.join('.')}`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = await qrcode.toDataURL(qr);
        }

        if (connection === 'close') {
            const status = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Conexão perdida (Status: ${status}).`);
            qrCodeData = null;
            
            const sessaoInvalida = [401, 403, 405, DisconnectReason.loggedOut].includes(status);
            if (sessaoInvalida) {
                console.log("❌ Sessão expirada. Apagando...");
                fs.rmSync(authPath, { recursive: true, force: true });
            }
            
            sock = null;
            setTimeout(iniciarZap, 5000);
        } else if (connection === 'open') {
            console.log('✅ SISTEMA ZAP ONLINE E PRONTO!');
            qrCodeData = null;
        }
    });
}

// ROTA: Enviar Mensagem (Protegida)
app.post('/api/enviar', verifyToken, async (req, res) => {
    if (!sock || !sock.user) return res.status(503).json({ status: 'offline' });

    const { numero, opcoes, arquivoBase64, tipo, texto, fileName, legenda, mimetype } = req.body;
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