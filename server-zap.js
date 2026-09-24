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

// 🟢 USA A PASTA PERMANENTE /data SE EXISTIR NO RENDER
const authDir = fs.existsSync('/data') ? '/data' : __dirname;
const authPath = path.join(authDir, 'sessao_zap');

if (!fs.existsSync(authPath)) {
    fs.mkdirSync(authPath, { recursive: true });
}

let sock = null;
let qrCodeData = null;
let isConnecting = false;

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
    if (isConnecting) return;
    isConnecting = true;

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
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 25000,
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
                isConnecting = false;
                const status = lastDisconnect?.error?.output?.statusCode;
                console.log(`⚠️ Conexão perdida (Status: ${status || 'desconhecido'}). Reconectando...`);
                qrCodeData = null;
                sock = null;
                
                // Se a sessão foi deslogada no celular (401, 403, 501), limpa credenciais
                const sessaoInvalida = [401, 403, DisconnectReason.loggedOut].includes(status);
                if (sessaoInvalida) {
                    console.log("❌ Sessão revogada. Limpando credenciais antigas...");
                    if (fs.existsSync(authPath)) {
                        fs.rmSync(authPath, { recursive: true, force: true });
                    }
                }
                
                setTimeout(iniciarZap, 5000);
            } else if (connection === 'open') {
                isConnecting = false;
                console.log('✅ SISTEMA ZAP ONLINE E PRONTO NO RENDER!');
                qrCodeData = null;
            }
        });
    } catch (err) {
        isConnecting = false;
        console.error("❌ Erro ao inicializar o Baileys:", err.message);
        setTimeout(iniciarZap, 5000);
    }
}

// ROTA: Enviar Mensagem (Com verificação real de JID)
app.post('/api/enviar', verifyToken, async (req, res) => {
    if (!sock || !sock.user) {
        return res.status(503).json({ success: false, status: 'offline', error: 'WhatsApp não está conectado' });
    }

    const { numero, arquivoBase64, tipo, texto, fileName, legenda, mimetype } = req.body;
    
    if (!numero) {
        return res.status(400).json({ success: false, error: 'Número não fornecido' });
    }

    let numLimpo = numero.replace(/\D/g, '');

    try {
        // 🟢 Identifica o endereço (JID) correto no WhatsApp (corrige o problema do 9º dígito)
        const [resultado] = await sock.onWhatsApp(numLimpo);

        if (!resultado || !resultado.exists) {
            console.log(`❌ [ZAP] Número ${numLimpo} não tem conta no WhatsApp.`);
            return res.status(404).json({ success: false, error: 'Número não encontrado no WhatsApp' });
        }

        const targetJid = resultado.jid; // Usa o JID oficial retornado pelo WhatsApp

        if (tipo === 'documento' && arquivoBase64) {
            const buffer = Buffer.from(arquivoBase64, 'base64');
            await sock.sendMessage(targetJid, { 
                document: buffer, 
                mimetype: mimetype || 'application/pdf', 
                fileName: fileName || 'Comprovante.pdf', 
                caption: legenda || '' 
            });
            console.log(`📄 [ZAP] Documento entregue em: ${targetJid}`);
        } else if (tipo === 'texto') {
            await sock.sendMessage(targetJid, { text: texto });
            console.log(`💬 [ZAP] Texto entregue em: ${targetJid}`);
        }

        res.json({ success: true, status: 'sent' });
    } catch (e) {
        console.error("❌ Erro no envio via WhatsApp:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});
// ROTA: Checar Status
app.get('/api/status', verifyToken, (req, res) => {
    if (sock && sock.user) return res.json({ status: 'online' });
    if (qrCodeData) return res.json({ status: 'aguardando_qr', qr: qrCodeData });
    res.json({ status: 'inicializando' });
});
// Adicione esta rota no código do microserviço do WhatsApp (porta 3001)
app.get('/api/reset-session', verifyToken, (req, res) => {
    try {
        if (sock) {
            sock.ws.close();
            sock = null;
        }
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }
        res.json({ success: true, message: "Sessão apagada. Um novo QR Code será gerado em instantes." });
        setTimeout(iniciarZap, 3000); // Reinicia o motor
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
app.listen(PORT, () => {
    console.log(`🚀 Microserviço do WhatsApp rodando na porta ${PORT}`);
    iniciarZap();
});