// Estiliza uma foto (cartoon / lápis / pintura) com efeitos clássicos de processamento de imagem.
// Não é IA generativa — tudo roda local e instantâneo, só com Jimp (JS puro, sem binário nativo,
// ao contrário do OpenCV: mantém o app leve e fácil de empacotar).
const { Jimp, BlendMode } = require('jimp');

const KERNEL_BORDA = [
  [-1, -1, -1],
  [-1, 8, -1],
  [-1, -1, -1],
];

async function cartoon(img) {
  const base = img.clone().posterize(7);
  const bordas = img.clone().greyscale().blur(2).convolute(KERNEL_BORDA);
  bordas.scan(0, 0, bordas.bitmap.width, bordas.bitmap.height, (x, y, idx) => {
    const v = bordas.bitmap.data[idx] > 22 ? 0 : 255; // teve variação forte = borda (preta); resto fica branco
    bordas.bitmap.data[idx] = bordas.bitmap.data[idx + 1] = bordas.bitmap.data[idx + 2] = v;
  });
  return base.composite(bordas, 0, 0, { mode: BlendMode.MULTIPLY, opacitySource: 1, opacityDest: 1 });
}

async function lapis(img) {
  const cinza = img.clone().greyscale();
  const invBorrado = cinza.clone().invert().blur(9);
  const out = cinza.clone();
  out.scan(0, 0, out.bitmap.width, out.bitmap.height, (x, y, idx) => {
    const base = cinza.bitmap.data[idx];
    const blend = invBorrado.bitmap.data[idx];
    const denom = 255 - blend;
    const v = denom <= 0 ? 255 : Math.min(255, Math.round((base * 255) / denom)); // "color dodge": o truque clássico do esboço a lápis
    out.bitmap.data[idx] = out.bitmap.data[idx + 1] = out.bitmap.data[idx + 2] = v;
  });
  return out;
}

async function pintura(img) {
  return img.clone().blur(3).posterize(13).contrast(0.08);
}

const EFEITOS = { cartoon, lapis, pintura };

/** Estiliza `origem` com `estilo` (cartoon|lapis|pintura) e salva em `saida`. */
async function estilizar(origem, saida, estilo = 'cartoon') {
  const fn = EFEITOS[estilo];
  if (!fn) throw new Error(`estilo "${estilo}" não existe (use cartoon, lapis ou pintura)`);
  const img = await Jimp.read(origem);
  const MAX = 1600; // generoso o bastante pra qualquer foto de uso comum; evita processar fotos gigantes de câmera devagar
  if (img.bitmap.width > MAX || img.bitmap.height > MAX) img.scaleToFit({ w: MAX, h: MAX });
  const out = await fn(img);
  await out.write(saida);
  return saida;
}

module.exports = { estilizar };
