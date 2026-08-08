const express = require('express');
const cors = require('cors');
const simpleGit = require('simple-git');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Carpeta pública para descargar reportes/archivos
app.use('/downloads', express.static(path.join(__dirname, 'builds')));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.post('/api/deploy', async (req, res) => {
  const { githubUrl, githubToken } = req.body;

  if (!githubUrl) {
    return res.status(400).json({ success: false, error: 'Ingresa la URL de GitHub.' });
  }

  const repoName = githubUrl.split('/').pop().replace('.git', '').toLowerCase();
  const projectId = `${repoName}-${Date.now().toString().slice(-4)}`;
  const buildDir = path.join(__dirname, 'builds', projectId);

  try {
    fs.mkdirSync(buildDir, { recursive: true });
    
    // Clonar repositorio
    let cloneUrl = githubUrl;
    if (githubToken && githubUrl.includes('github.com')) {
      cloneUrl = githubUrl.replace('https://', `https://${githubToken}@`);
    }

    console.log(`Clonando repositorio: ${githubUrl}...`);
    await simpleGit().clone(cloneUrl, buildDir);

    // Intentar construir con Docker
    console.log(`Construyendo imagen Docker para ${projectId}...`);
    const buildResult = await ejecutarComando(`docker build -t ${projectId} ${buildDir}`);

    if (!buildResult.success) {
      console.log('Fallo en la compilación. Consultando a Gemini para corregir...');
      
      const prompt = `Falló la compilación Docker del proyecto.
      ErrorLog: ${buildResult.error}
      Analiza el error de forma concisa en español y dime qué ajustar en el repositorio o archivos.`;

      const aiResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });

      const aiAnalysis = aiResponse.text;

      // Guardar archivo de reporte
      const reportPath = path.join(buildDir, 'reporte_error.txt');
      fs.writeFileSync(reportPath, `LOG DE ERROR:\n${buildResult.error}\n\nANÁLISIS IA:\n${aiAnalysis}`);

      return res.json({
        success: false,
        message: 'Fallo al compilar la aplicación.',
        aiAnalysis: aiAnalysis,
        logFileUrl: `/downloads/${projectId}/reporte_error.txt`
      });
    }

    // Ejecutar el contenedor 24/7 en un puerto aleatorio
    const port = Math.floor(Math.random() * 1000) + 4000;
    await ejecutarComando(`docker run -d --name ${projectId} -p ${port}:80 --restart always ${projectId}`);

    const deployedUrl = `http://${process.env.SERVER_DOMAIN || 'localhost'}:${port}`;
    
    // Crear archivo JSON informativo
    const infoPath = path.join(buildDir, 'despliegue.json');
    fs.writeFileSync(infoPath, JSON.stringify({ id: projectId, port, url: deployedUrl }, null, 2));

    return res.json({
      success: true,
      message: '¡Aplicación desplegada con éxito y disponible 24/7!',
      url: deployedUrl,
      configFileUrl: `/downloads/${projectId}/despliegue.json`
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

function ejecutarComando(comando) {
  return new Promise((resolve) => {
    exec(comando, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, log: stdout });
      }
    });
  });
}

app.listen(process.env.PORT || 3000, () => {
  console.log(`Servidor escuchando en el puerto ${process.env.PORT || 3000}`);
});
