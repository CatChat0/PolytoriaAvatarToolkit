const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_TRIANGLES = 500000;
const FILE_LOAD_TIMEOUT = 30000;

// check actual file content, not just the extension
const FILE_SIGNATURES = {
    png: '89504e47',
    jpg: 'ffd8ff',
    jpeg: 'ffd8ff',
    glb: '676c5446'
};

function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return '';
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function sanitizeFilename(filename) {
    if (typeof filename !== 'string') return 'unnamed';
    return filename
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/\.{2,}/g, '.')
        .substring(0, 255);
}

async function validateFileSignature(file, expectedTypes) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        
        reader.onload = function(e) {
            try {
                const arr = new Uint8Array(e.target.result).subarray(0, 8);
                let header = '';
                for (let i = 0; i < arr.length; i++) {
                    header += arr[i].toString(16).padStart(2, '0');
                }
                
                const isValid = expectedTypes.some(type => 
                    header.startsWith(FILE_SIGNATURES[type])
                );
                
                resolve(isValid);
            } catch (error) {
                reject(error);
            }
        };
        
        reader.onerror = () => reject(new Error('File read error'));
        reader.readAsArrayBuffer(file.slice(0, 8));
    });
}

async function validateImageFile(file) {
    if (file.size > MAX_IMAGE_SIZE) {
        throw new Error(`Image too large! Maximum size is ${MAX_IMAGE_SIZE / 1024 / 1024}MB`);
    }
    
    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.')).substring(1);
    if (!['png', 'jpg', 'jpeg'].includes(ext)) {
        throw new Error('Invalid file extension. Only PNG and JPEG allowed.');
    }
    
    const isValid = await validateFileSignature(file, ['png', 'jpg', 'jpeg']);
    if (!isValid) {
        throw new Error('File content does not match extension. Possible file spoofing detected.');
    }
    
    return true;
}

async function validateGLBFile(file) {
    if (file.size > MAX_FILE_SIZE) {
        throw new Error(`File too large! Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`);
    }
    
    if (!file.name.toLowerCase().endsWith('.glb')) {
        throw new Error('Invalid file extension. Only .glb files allowed.');
    }
    
    const isValid = await validateFileSignature(file, ['glb']);
    if (!isValid) {
        throw new Error('File is not a valid GLB file. Possible file spoofing detected.');
    }
    
    return true;
}

function validateGLTFModel(gltf) {
    try {
        let totalTriangles = 0;
        
        gltf.scene.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const geometry = child.geometry;
                
                if (geometry.index) {
                    totalTriangles += geometry.index.count / 3;
                } else if (geometry.attributes.position) {
                    totalTriangles += geometry.attributes.position.count / 3;
                }
                
                if (child.material) {
                    const material = child.material;
                    
                    if (material.onBeforeCompile && !material.userData.allowedShader) {
                        console.warn('Model contains custom shader code - blocked for security');
                        return false;
                    }
                }
            }
        });
        
        if (totalTriangles > MAX_TRIANGLES) {
            throw new Error(`Model has too many triangles (${Math.floor(totalTriangles).toLocaleString()}). Maximum: ${MAX_TRIANGLES.toLocaleString()}`);
        }
        
        return true;
    } catch (error) {
        console.error('Model validation error:', error);
        throw error;
    }
}

async function loadImageSafely(file, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const timeoutId = setTimeout(() => {
            img.src = '';
            reject(new Error('Image load timeout'));
        }, timeout);
        
        img.onload = () => {
            clearTimeout(timeoutId);
            
            if (img.width > 8192 || img.height > 8192) {
                URL.revokeObjectURL(img.src);
                reject(new Error('Image dimensions too large (max 8192x8192)'));
                return;
            }
            
            resolve(img);
        };
        
        img.onerror = () => {
            clearTimeout(timeoutId);
            URL.revokeObjectURL(img.src);
            reject(new Error('Failed to load image'));
        };
        
        try {
            img.src = URL.createObjectURL(file);
        } catch (e) {
            clearTimeout(timeoutId);
            reject(new Error('Failed to create image URL'));
        }
    });
}

function safeCreateObjectURL(blob) {
    try {
        return URL.createObjectURL(blob);
    } catch (e) {
        console.error('Failed to create object URL:', e);
        return null;
    }
}

function safeRevokeObjectURL(url) {
    try {
        if (url) URL.revokeObjectURL(url);
    } catch (e) {
        console.error('Failed to revoke object URL:', e);
    }
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });

const canvasContainer = document.getElementById('canvas-container');
const rect = canvasContainer.getBoundingClientRect();
renderer.setSize(rect.width, rect.height);
renderer.outputEncoding = THREE.sRGBEncoding;
canvasContainer.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const light = new THREE.DirectionalLight(0xffffff, 0.6);
light.position.set(5, 10, 7);
scene.add(light);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
camera.position.set(0, -3.3, 4);
controls.target.set(0, -3.3, 0);
controls.update();

const gridHelper = new THREE.GridHelper(30, 30, 0x333333, 0x1a1a1a);
gridHelper.position.y = -4.75;
gridHelper.visible = true;
gridHelper.material.transparent = true;
gridHelper.material.opacity = 1.0;

const fadeShader = (shader) => {
    shader.uniforms.fadeDistance = { value: 15.0 };
    shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vWorldPosition;`
    );
    shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nvWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vWorldPosition;\nuniform float fadeDistance;`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>\nfloat distFromCenter = length(vWorldPosition.xz);\nfloat fadeFactor = 1.0 - smoothstep(8.0, fadeDistance, distFromCenter);\ndiffuseColor.a *= fadeFactor;`
    );
};

gridHelper.material.onBeforeCompile = fadeShader;
gridHelper.material.userData.allowedShader = true;

scene.add(gridHelper);

let polyModel = null;
let currentSkinTone = new THREE.Color(0xcccccc);
let currentTexture = null;
let faceTexture = null;
let activeTextures = { shirt: null, pants: null, face: null };
let equippedUgc = [];

const BODY_PARTS = {
    shirt: ['torso', 'leftarm', 'rightarm', 'lefthand', 'righthand'],
    pants: ['leftleg', 'rightleg', 'leftfoot', 'rightfoot'],
    face: ['head', 'face']
};

const rbxMapData = { 
    "top_parts": [
        {"rect": [231, 8, 128, 64]},
        {"rect": [165, 74, 64, 128]},
        {"rect": [231, 74, 128, 128]},
        {"rect": [361, 74, 64, 128]},
        {"rect": [427, 74, 128, 128]},
        {"rect": [231, 204, 128, 64]}
    ],
    "bottom_parts": [
        {"rect": [217, 289, 64, 64]},
        {"rect": [308, 289, 64, 64]},
        {"rect": [19, 355, 64, 128]},
        {"rect": [85, 355, 64, 128]},
        {"rect": [151, 355, 64, 128]},
        {"rect": [217, 355, 64, 128]},
        {"rect": [308, 355, 64, 128]},
        {"rect": [374, 355, 64, 128]},
        {"rect": [440, 355, 64, 128]},
        {"rect": [506, 355, 64, 128]},
        {"rect": [217, 485, 64, 64]},
        {"rect": [308, 485, 64, 64]}
    ]
};

const polyMapData = { 
    "top_parts": [
        {"rect": [199, 74, 200, 100]},
        {"rect": [89, 184, 100, 200]},
        {"rect": [199, 184, 200, 200]},
        {"rect": [409, 184, 100, 200]},
        {"rect": [519, 184, 200, 200]},
        {"rect": [199, 394, 200, 100]}
    ],
    "bottom_parts": [
        {"rect": [382, 557, 100, 100]},
        {"rect": [538, 557, 100, 100]},
        {"rect": [52, 667, 100, 200]},
        {"rect": [162, 667, 100, 200]},
        {"rect": [272, 667, 100, 200]},
        {"rect": [382, 667, 100, 200]},
        {"rect": [538, 667, 100, 200]},
        {"rect": [649, 667, 100, 200]},
        {"rect": [759, 667, 100, 200]},
        {"rect": [870, 667, 100, 200]},
        {"rect": [382, 877, 100, 100]},
        {"rect": [538, 877, 100, 100]}
    ]
};

class SkinOverlayMaterial extends THREE.MeshStandardMaterial {
    constructor(params) {
        const { skinColor, ...standardParams } = params;
        super(standardParams);
        this.skinColor = skinColor || new THREE.Color(0xcccccc);
        this.userData.allowedShader = true;
    }

    onBeforeCompile(shader) {
        shader.uniforms.skinColor = { value: this.skinColor };
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <map_fragment>',
            `
            #ifdef USE_MAP
                vec4 texelColor = texture2D( map, vUv );
                texelColor = mapTexelToLinear( texelColor );
                diffuseColor.rgb = mix(skinColor, texelColor.rgb, texelColor.a);
                diffuseColor.a = 1.0;
            #else
                diffuseColor.rgb = skinColor;
            #endif
            `
        );
        shader.fragmentShader = 'uniform vec3 skinColor;\n' + shader.fragmentShader;
    }
}

function createMaterial(color, texture) {
    const params = {
        roughness: 0.8,
        metalness: 0.1,
        side: THREE.FrontSide,
        flatShading: false
    };

    if (texture) {
        return new SkinOverlayMaterial({
            ...params,
            map: texture,
            skinColor: color.clone(),
        });
    } else {
        return new THREE.MeshStandardMaterial({
            ...params,
            color: color,
        });
    }
}

function updateStatus(message, type = 'info') {
    const status = document.getElementById('ugcStatus');
    if (!status) return;
    
    status.textContent = String(message);
    status.className = 'status-text';
    if (type === 'success') status.classList.add('success');
    if (type === 'error') status.classList.add('error');
    if (type === 'loading') status.classList.add('loading');
}

function loadModelFromPath(path) {
    updateStatus('Loading model...', 'loading');
    
    const savedUgc = [];
    if (polyModel) {
        equippedUgc.forEach(ugc => {
            if (ugc && ugc.parent) {
                savedUgc.push({
                    object: ugc.clone(),
                    parentName: ugc.parent.name,
                    position: ugc.position.clone(),
                    rotation: ugc.rotation.clone(),
                    scale: ugc.scale.clone(),
                    fileName: ugc.userData.fileName || 'Accessory'
                });
            }
        });
        scene.remove(polyModel);
    }
    
    const loader = new THREE.GLTFLoader();
    loader.load(path, (gltf) => {
        polyModel = gltf.scene;

        const box = new THREE.Box3().setFromObject(polyModel);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        
        polyModel.position.sub(center);
        polyModel.position.y += size.y * 0.05;
        
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = 2.0 / maxDim;
        polyModel.scale.set(scale, scale, scale);

        polyModel.traverse(child => {
            if (child.isMesh) {
                child.material = createMaterial(currentSkinTone, null);
            }
        });
        
        scene.add(polyModel);
        
        equippedUgc = [];
        savedUgc.forEach(ugcData => {
            let attached = false;
            polyModel.traverse(child => {
                if (!attached && child.name === ugcData.parentName) {
                    ugcData.object.position.copy(ugcData.position);
                    ugcData.object.rotation.copy(ugcData.rotation);
                    ugcData.object.scale.copy(ugcData.scale);
                    ugcData.object.userData.fileName = ugcData.fileName;
                    child.add(ugcData.object);
                    equippedUgc.push(ugcData.object);
                    attached = true;
                }
            });
        });
        
        if (faceTexture) applyFaceTexture();
        
        for (const category in activeTextures) {
            if (activeTextures[category]) {
                applyTextureToCategory(category, activeTextures[category]);
            }
        }
        
        updateUgcList();
        updateStatus('Model loaded', 'success');
    }, undefined, (error) => {
        updateStatus('Failed to load model', 'error');
        console.error('Model load error:', error);
    });
}

function loadFaceDecal(path) {
    if (!polyModel) return;
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(path, (texture) => {
        texture.flipY = false;
        texture.encoding = THREE.sRGBEncoding;
        faceTexture = texture;
        applyFaceTexture();
    }, undefined, (error) => {
        console.warn('Could not load face decal:', error);
    });
}

function applyFaceTexture() {
    if (!polyModel || !faceTexture) return;
    polyModel.traverse(child => {
        if (child.isMesh) {
            const meshName = child.name.toLowerCase();
            if (meshName.includes('head') || meshName.includes('face')) {
                child.material = createMaterial(currentSkinTone, faceTexture);
                child.material.needsUpdate = true;
            }
        }
    });
}

function applyTextureToCategory(category, texture) {
    if (!polyModel || !texture) return;
    
    const bodyParts = BODY_PARTS[category];
    if (!bodyParts) return;
    
    polyModel.traverse(child => {
        if (child.isMesh && !child.userData.isUGC) {
            const meshName = child.name.toLowerCase();
            if (bodyParts.some(part => meshName.includes(part))) {
                child.material = createMaterial(currentSkinTone, texture);
                child.material.needsUpdate = true;
            }
        }
    });
}

function refreshModelTextures(keepExisting, currentCategory) {
    if (!polyModel) return;
    
    polyModel.traverse(child => {
        if (child.isMesh) {
            if (child.userData.isUGC) return;

            const meshName = child.name.toLowerCase();
            let appliedTexture = null;

            const isCurrentTarget = BODY_PARTS[currentCategory]?.some(part => meshName.includes(part));
            
            if (isCurrentTarget) {
                appliedTexture = activeTextures[currentCategory];
            } 
            else if (keepExisting) {
                for (const category in activeTextures) {
                    if (BODY_PARTS[category]?.some(part => meshName.includes(part))) {
                        appliedTexture = activeTextures[category];
                        break;
                    }
                }
            }

            if (!appliedTexture && (meshName.includes('head') || meshName.includes('face'))) {
                appliedTexture = faceTexture;
            }

            child.material = createMaterial(currentSkinTone, appliedTexture);
            child.material.needsUpdate = true;
        }
    });
}

function updateUgcList() {
    renderUgcList();
}

function renderUgcList() {
    const listContainer = document.getElementById('ugcList');
    if (!listContainer) return;
    
    listContainer.innerHTML = '';
    
    // build elements manually instead of innerHTML to avoid xss
    equippedUgc.forEach((item, index) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'checkbox-option';
        wrapper.style.cssText = 'justify-content: space-between; margin-bottom: 5px; border-radius: 30px; display: flex; align-items: center; padding: 5px 15px; background: rgba(255,255,255,0.05);';
        
        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px;';
        nameSpan.textContent = sanitizeFilename(item.userData.fileName || `Accessory ${index + 1}`);
        
        const controlsDiv = document.createElement('div');
        controlsDiv.style.cssText = 'display: flex; gap: 10px; align-items: center;';
        
        const isVisible = item.visible !== false;
        const toggleSpan = document.createElement('span');
        toggleSpan.style.cssText = 'cursor: pointer; font-size: 14px;';
        toggleSpan.textContent = isVisible ? '👁️' : '🙈';
        toggleSpan.title = 'Toggle Visibility';
        toggleSpan.addEventListener('click', () => toggleSingleUgc(index));
        
        const removeSpan = document.createElement('span');
        removeSpan.style.cssText = 'color: #ef4444; cursor: pointer; font-weight: bold; font-size: 14px;';
        removeSpan.textContent = '✕';
        removeSpan.title = 'Remove';
        removeSpan.addEventListener('click', () => removeUgc(index));
        
        controlsDiv.appendChild(toggleSpan);
        controlsDiv.appendChild(removeSpan);
        
        wrapper.appendChild(nameSpan);
        wrapper.appendChild(controlsDiv);
        listContainer.appendChild(wrapper);
    });
}

function removeUgc(index) {
    const item = equippedUgc[index];
    if (item && polyModel) {
        polyModel.remove(item);
        equippedUgc.splice(index, 1);
        renderUgcList();
    }
}

function toggleSingleUgc(index) {
    const item = equippedUgc[index];
    if (item) {
        item.visible = !item.visible;
        renderUgcList();
    }
}

async function loadUgc(file) {
    if (equippedUgc.length >= 9) {
        updateStatus("Maximum 9 accessories reached!", "error");
        return;
    }
    if (!polyModel) {
        updateStatus("Please load a character model first!", "error");
        return;
    }

    try {
        await validateGLBFile(file);
        
        updateStatus(`Loading ${sanitizeFilename(file.name)}...`, 'loading');

        const reader = new FileReader();
        
        await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error('GLB load timeout'));
            }, FILE_LOAD_TIMEOUT);
            
            reader.onload = function(event) {
                clearTimeout(timeoutId);
                const contents = event.target.result;
                const loader = new THREE.GLTFLoader();

                loader.parse(contents, '', (gltf) => {
                    try {
                        validateGLTFModel(gltf);
                        
                        const accessory = gltf.scene;
                        
                        accessory.traverse(child => {
                            if (child.isMesh) {
                                child.userData.isUGC = true;
                                child.castShadow = true;
                                
                                // remove any custom shaders that weren't marked safe
                                if (child.material && child.material.onBeforeCompile) {
                                    if (!child.material.userData.allowedShader) {
                                        delete child.material.onBeforeCompile;
                                    }
                                }
                            }
                        });

                        accessory.userData.fileName = sanitizeFilename(file.name);
                        polyModel.add(accessory);
                        equippedUgc.push(accessory);

                        renderUgcList();
                        updateStatus("Accessory added!", "success");
                        resolve();
                    } catch (err) {
                        updateStatus(err.message, "error");
                        reject(err);
                    }
                }, (err) => {
                    clearTimeout(timeoutId);
                    updateStatus("Failed to parse GLB file", "error");
                    reject(err);
                });
            };
            
            reader.onerror = () => {
                clearTimeout(timeoutId);
                reject(new Error('File read error'));
            };

            reader.readAsArrayBuffer(file);
        });
    } catch (error) {
        updateStatus(error.message, "error");
        console.error('UGC load error:', error);
    }
}

async function downloadTexturesZip() {
    if (!polyModel) {
        updateStatus("Please load a character first!", "error");
        return;
    }
    
    updateStatus("Preparing ZIP Archive...", "loading");

    try {
        if (typeof JSZip === 'undefined') {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
            script.integrity = 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG';
            script.crossOrigin = 'anonymous';
            document.head.appendChild(script);
            await new Promise((resolve, reject) => {
                script.onload = resolve;
                script.onerror = () => reject(new Error('Failed to load JSZip'));
            });
        }

        const zip = new JSZip();
        const textureFolder = zip.folder("textures");
        let textureCount = 0;

        polyModel.traverse((child) => {
            if (child.isMesh && child.material) {
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                
                materials.forEach((mat) => {
                    if (mat.map && mat.map.image) {
                        try {
                            const canvas = document.createElement('canvas');
                            const img = mat.map.image;
                            canvas.width = img.width;
                            canvas.height = img.height;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(img, 0, 0);

                            const dataUrl = canvas.toDataURL("image/png");
                            const base64Data = dataUrl.replace(/^data:image\/(png|jpg);base64,/, "");

                            const safeName = sanitizeFilename(child.name || 'accessory');
                            const fileName = `${safeName}_${textureCount}.png`;
                            textureFolder.file(fileName, base64Data, {base64: true});
                            textureCount++;
                        } catch (e) {
                            console.warn(`Could not extract texture:`, e);
                        }
                    }
                });
            }
        });

        if (textureCount === 0) {
            updateStatus("No textures found to export", "error");
            return;
        }

        const content = await zip.generateAsync({type: "blob"});
        const url = safeCreateObjectURL(content);
        
        if (!url) {
            updateStatus("Failed to create download", "error");
            return;
        }
        
        const link = document.createElement('a');
        link.href = url;
        link.download = "character_textures.zip";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        setTimeout(() => safeRevokeObjectURL(url), 100);
        
        updateStatus(`ZIP Downloaded! (${textureCount} textures)`, "success");
    } catch (error) {
        updateStatus("ZIP export failed", "error");
        console.error('ZIP error:', error);
    }
}

async function downloadGeometry() {
    if (!polyModel) {
        updateStatus("Please load a character first!", "error");
        return;
    }
    
    updateStatus("Exporting geometry...", "loading");

    try {
        const exporter = new THREE.GLTFExporter();
        const exportScene = new THREE.Scene();
        const cleanModel = polyModel.clone();
        
        cleanModel.traverse((child) => {
            if (child.isMesh) {
                child.material = new THREE.MeshStandardMaterial({
                    color: 0xffffff,
                    roughness: 0.8,
                    metalness: 0.1
                });
                child.material.map = null;
                child.material.emissiveMap = null;
                child.material.normalMap = null;
            }
        });

        exportScene.add(cleanModel);

        exporter.parse(
            exportScene,
            (result) => {
                const blob = new Blob([result], { type: 'application/octet-stream' });
                const url = safeCreateObjectURL(blob);
                
                if (!url) {
                    updateStatus("Failed to create download", "error");
                    return;
                }
                
                const link = document.createElement('a');
                link.href = url;
                link.download = "character_geometry.glb";
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                
                setTimeout(() => safeRevokeObjectURL(url), 100);
                
                updateStatus("Geometry downloaded!", "success");
            },
            (err) => {
                console.error("Export error:", err);
                updateStatus("Export failed", "error");
            },
            { binary: true }
        );
    } catch (error) {
        updateStatus("Export failed", "error");
        console.error('Export error:', error);
    }
}

const bgInput = document.getElementById('bgColor');
if (bgInput) {
    bgInput.addEventListener('input', e => {
        renderer.setClearColor(e.target.value);
    });
}

const skinInput = document.getElementById('skinTone');
if (skinInput) {
    skinInput.addEventListener('input', e => {
        currentSkinTone = new THREE.Color(e.target.value);
        if (!polyModel) return;
        polyModel.traverse(child => {
            if (child.isMesh && !child.userData.isUGC) {
                if (child.material.skinColor) {
                    child.material.skinColor.copy(currentSkinTone);
                } else {
                    child.material.color.copy(currentSkinTone);
                }
                child.material.needsUpdate = true;
            }
        });
    });
}

const gridInput = document.getElementById('showGrid');
if (gridInput) {
    gridInput.addEventListener('change', e => {
        gridHelper.visible = e.target.checked;
    });
}

const uploadInput = document.getElementById('upload');
if (uploadInput) {
    uploadInput.addEventListener('change', async function(e) {
        if (!polyModel) {
            updateStatus('Please load a character model first!', 'error');
            this.value = '';
            return;
        }
        
        const file = e.target.files[0];
        if (!file) return;
        
        try {
            await validateImageFile(file);
            
            const img = await loadImageSafely(file);
            
            const texture = new THREE.Texture(img);
            texture.flipY = false;
            texture.encoding = THREE.sRGBEncoding;
            texture.needsUpdate = true;
            
            const clothingType = document.getElementById('clothingType')?.value || 'shirt';
            const keepExisting = document.getElementById('keepTextures')?.checked ?? true;

            activeTextures[clothingType] = texture;
            if (clothingType === 'face') faceTexture = texture;
            
            refreshModelTextures(keepExisting, clothingType);
            
            safeRevokeObjectURL(img.src);
            
            updateStatus('Texture applied successfully!', 'success');
        } catch (error) {
            updateStatus(error.message, 'error');
            this.value = '';
        }
    });
}

const clearBtn = document.getElementById('clearBtn');
if (clearBtn) {
    clearBtn.addEventListener('click', () => {
        if (!polyModel) return;
        
        activeTextures = { shirt: null, pants: null, face: null };
        faceTexture = null;
        
        polyModel.traverse(child => {
            if (child.isMesh) {
                child.material = createMaterial(currentSkinTone, null);
                child.material.needsUpdate = true;
            }
        });
        
        const upload = document.getElementById('upload');
        if (upload) upload.value = '';
        
        updateStatus('Textures cleared', 'info');
    });
}

const ugcUpload = document.getElementById('ugcUpload');
if (ugcUpload) {
    ugcUpload.addEventListener('change', async function(e) {
        const file = e.target.files[0];
        this.value = '';
        
        if (!file) return;
        
        if (!polyModel) {
            updateStatus('Please load a character model first!', 'error');
            return;
        }

        await loadUgc(file);
    });
}

const clearUgcBtn = document.getElementById('clearUgcBtn');
if (clearUgcBtn) {
    clearUgcBtn.addEventListener('click', () => {
        if (!polyModel) return;
        equippedUgc.forEach(item => {
            if (item) polyModel.remove(item);
        });
        equippedUgc = [];
        renderUgcList();
        updateStatus("All accessories cleared", "info");
    });
}

const downloadGeometryBtn = document.getElementById('downloadGeometryBtn');
if (downloadGeometryBtn) {
    downloadGeometryBtn.addEventListener('click', downloadGeometry);
}

const downloadTexturesBtn = document.getElementById('downloadTexturesBtn');
if (downloadTexturesBtn) {
    downloadTexturesBtn.addEventListener('click', downloadTexturesZip);
}

const convertBtn = document.getElementById('convertBtn');
if (convertBtn) {
    convertBtn.addEventListener('click', async () => {
        const fileInput = document.getElementById('converterInput');
        const file = fileInput?.files[0];
        
        if (!file) {
            updateStatus('Please select a template image first!', 'error');
            return;
        }
        
        try {
            await validateImageFile(file);
            
            const mode = document.querySelector('input[name="convertMode"]:checked')?.value || 'rbx2poly';
            const isRbx2Poly = mode === 'rbx2poly';
            const srcMap = isRbx2Poly ? rbxMapData : polyMapData;
            const destMap = isRbx2Poly ? polyMapData : rbxMapData;
            
            updateStatus('Converting...', 'loading');
            
            const img = await loadImageSafely(file);
            
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d', { 
                willReadFrequently: true,
                alpha: true 
            }); 
            
            canvas.width = isRbx2Poly ? 1024 : 585;
            canvas.height = isRbx2Poly ? 1024 : 559;
            
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            
            ['top_parts', 'bottom_parts'].forEach(category => {
                srcMap[category].forEach((srcNode, index) => {
                    const destNode = destMap[category][index];
                    if (!destNode) return;
                    const [sx, sy, sw, sh] = srcNode.rect;
                    const [dx, dy, dw, dh] = destNode.rect;
                    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
                });
            });
            
            safeRevokeObjectURL(img.src);
            
            canvas.toBlob((blob) => {
                if (!blob) {
                    updateStatus('Conversion failed', 'error');
                    return;
                }
                
                const url = safeCreateObjectURL(blob);
                if (!url) {
                    updateStatus('Failed to create download', 'error');
                    return;
                }
                
                const link = document.createElement('a');
                link.download = isRbx2Poly ? 'polytoria_template.png' : 'roblox_template.png';
                link.href = url;
                
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                
                setTimeout(() => safeRevokeObjectURL(url), 100);
                
                updateStatus('Conversion complete!', 'success');
            }, 'image/png', 1.0);
        } catch (error) {
            updateStatus(error.message, 'error');
            console.error('Conversion error:', error);
        }
    });
}

window.addEventListener('load', () => {
    const bg = document.getElementById('bgColor');
    if (bg) {
        renderer.setClearColor(bg.value);
    }
    
    loadModelFromPath('assets/rigs/character.glb');
    setTimeout(() => loadFaceDecal('assets/face/Smile.png'), 1000);
    
    const mobileToggle = document.getElementById('mobile-toggle');
    const controlsPanel = document.getElementById('controls-panel');
    
    if (mobileToggle && controlsPanel) {
        let startY = 0;
        let currentY = 0;
        let isDragging = false;
        
        mobileToggle.addEventListener('touchstart', (e) => {
            startY = e.touches[0].clientY;
            isDragging = true;
        }, { passive: true });
        
        mobileToggle.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            currentY = e.touches[0].clientY;
            const deltaY = currentY - startY;
            
            if (Math.abs(deltaY) > 10) {
                const isOpen = controlsPanel.classList.contains('open');
                
                if (deltaY > 50 && isOpen) {
                    controlsPanel.classList.remove('open');
                    isDragging = false;
                } else if (deltaY < -50 && !isOpen) {
                    controlsPanel.classList.add('open');
                    isDragging = false;
                }
            }
        }, { passive: true });
        
        mobileToggle.addEventListener('touchend', () => {
            if (isDragging && Math.abs(currentY - startY) < 10) {
                controlsPanel.classList.toggle('open');
            }
            isDragging = false;
        }, { passive: true });
        
        mobileToggle.addEventListener('click', () => {
            if (window.innerWidth > 768) {
                controlsPanel.classList.toggle('open');
            }
        });
    }
    
    setupDropZone('converterDropZone', 'converterInput', ['image/png', 'image/jpeg', 'image/jpg']);
    setupDropZone('clothingDropZone',  'upload',         ['image/png', 'image/jpeg', 'image/jpg']);
    setupDropZone('ugcDropZone', 'ugcUpload', ['model/gltf-binary', '.glb']);
    
    function getModelPath() {
        const gender = document.querySelector('input[name="characterGender"]:checked')?.value ?? 'male';
        const rig    = document.querySelector('input[name="rigType"]:checked')?.value ?? 'new';
        if (rig === 'legacy') {
            return gender === 'female'
                ? 'assets/legacy_rigs/old_character_female.glb'
                : 'assets/legacy_rigs/old_character.glb';
        }
        return gender === 'female'
            ? 'assets/rigs/character_female.glb'
            : 'assets/rigs/character.glb';
    }

    document.querySelectorAll('input[name="characterGender"]').forEach(radio => {
        radio.addEventListener('change', () => loadModelFromPath(getModelPath()));
    });

    document.querySelectorAll('input[name="rigType"]').forEach(radio => {
        radio.addEventListener('change', () => loadModelFromPath(getModelPath()));
    });

    // Initialize color pickers
    function initColorPickers() {
        [
            { inputId: 'bgColor',  dotId: 'bgColorDot',  hexId: 'bgColorHex',  fieldId: 'bgColorField'  },
            { inputId: 'skinTone', dotId: 'skinToneDot', hexId: 'skinToneHex', fieldId: 'skinToneField' }
        ].forEach(({ inputId, dotId, hexId, fieldId }) => {
            const input = document.getElementById(inputId);
            const dot   = document.getElementById(dotId);
            const hex   = document.getElementById(hexId);
            const field = document.getElementById(fieldId);
            if (!input || !dot || !hex || !field) return;

            function sync() {
                const c = input.value;
                const r = parseInt(c.slice(1, 3), 16);
                const g = parseInt(c.slice(3, 5), 16);
                const b = parseInt(c.slice(5, 7), 16);
                field.style.background  = `rgba(${r},${g},${b},0.18)`;
                field.style.borderColor = `rgba(${r},${g},${b},0.35)`;
                dot.style.background    = c;
                hex.style.color         = c;
                hex.textContent         = c.toUpperCase();
            }

            input.addEventListener('input', sync);
            sync();
        });
    }

    initColorPickers();
});

function setupDropZone(dropZoneId, inputId, acceptedTypes) {
    const dropZone = document.getElementById(dropZoneId);
    const input = document.getElementById(inputId);
    
    if (!dropZone || !input) return;
    
    const textElement = dropZone.querySelector('.drop-zone-text');
    const originalText = textElement ? textElement.textContent : '';
    
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });
    
    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.add('drag-over');
        });
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.remove('drag-over');
        });
    });
    
    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        
        if (files.length > 0) {
            const file = files[0];
            const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
            const isValid = acceptedTypes.some(type => 
                file.type === type || fileExtension === type || type.includes(fileExtension)
            );
            
            if (isValid) {
                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(file);
                input.files = dataTransfer.files;
                
                if (textElement) {
                    updateDropZoneText(dropZone, textElement, sanitizeFilename(file.name));
                }
                
                const event = new Event('change', { bubbles: true });
                input.dispatchEvent(event);
            } else {
                updateStatus('Invalid file type. Please upload the correct format.', 'error');
            }
        }
    });
    
    dropZone.addEventListener('click', (e) => {
        if (e.target !== input) {
            input.click();
        }
    });
    
    input.addEventListener('change', () => {
        if (!textElement) return;
        
        if (input.files.length > 0) {
            updateDropZoneText(dropZone, textElement, sanitizeFilename(input.files[0].name));
        } else {
            resetDropZoneText(dropZone, textElement, originalText);
        }
    });
    
    function updateDropZoneText(zone, text, fileName) {
        zone.classList.add('has-file');
        text.classList.add('file-selected');
        text.textContent = `✓ ${fileName}`;
    }
    
    function resetDropZoneText(zone, text, original) {
        zone.classList.remove('has-file');
        text.classList.remove('file-selected');
        text.textContent = original;
    }
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
    const rect = canvasContainer.getBoundingClientRect();
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
    renderer.setSize(rect.width, rect.height);
});
