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
        `
        #include <common>
        varying vec3 vWorldPosition;
        `
    );
    shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        `
    );
    shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `
        #include <common>
        varying vec3 vWorldPosition;
        uniform float fadeDistance;
        `
    );
    shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        float distFromCenter = length(vWorldPosition.xz);
        float fadeFactor = 1.0 - smoothstep(8.0, fadeDistance, distFromCenter);
        diffuseColor.a *= fadeFactor;
        `
    );
};

gridHelper.material.onBeforeCompile = fadeShader;

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
    const status = document.getElementById('status');
    if (!status) return;
    status.textContent = message;
    status.className = 'status-text';
    if (type === 'success') status.classList.add('success');
    if (type === 'error') status.classList.add('error');
    if (type === 'loading') status.classList.add('loading');
}

function loadModelFromPath(path) {
    updateStatus('Loading model...', 'loading');
    
    // Store UGC accessories before removing old model
    const savedUgc = [];
    if (polyModel) {
        equippedUgc.forEach(ugc => {
            if (ugc && ugc.parent) {
                // Save UGC data including position, rotation, scale
                savedUgc.push({
                    object: ugc.clone(), // Clone the UGC object
                    parentName: ugc.parent.name,
                    position: ugc.position.clone(),
                    rotation: ugc.rotation.clone(),
                    scale: ugc.scale.clone(),
                    fileName: ugc.userData.fileName
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
        
        // Re-attach saved UGC accessories to new model
        equippedUgc = []; // Clear the old array
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
        
        // Reapply all active textures
        if (faceTexture) {
            applyFaceTexture();
        }
        
        // Reapply shirt, pants, and face textures
        for (const category in activeTextures) {
            if (activeTextures[category]) {
                applyTextureToCategory(category, activeTextures[category]);
            }
        }
        
        // Update the UGC list UI
        updateUgcList();
        
        updateStatus('Model loaded', 'success');
    }, undefined, (error) => {
        updateStatus('Failed to auto-load', 'error');
        console.error('Auto-load error:', error);
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
        console.warn('Could not load smile.png:', error);
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

function applyClothingTexture(texture) {
    if (!polyModel) return;

    polyModel.traverse((child) => {
        if (child.isMesh && !child.userData.isUGC) {
            child.material = createMaterial(currentSkinTone, texture);
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

            const isCurrentTarget = BODY_PARTS[currentCategory].some(part => meshName.includes(part));
            
            if (isCurrentTarget) {
                appliedTexture = activeTextures[currentCategory];
            } 
            else if (keepExisting) {
                for (const category in activeTextures) {
                    if (BODY_PARTS[category].some(part => meshName.includes(part))) {
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

function renderUgcList() {
    const listContainer = document.getElementById('ugcList');
    listContainer.innerHTML = equippedUgc.map((item, index) => {
        const isVisible = item.visible !== false;
        const eyeIcon = isVisible ? '👁️' : '🙈'; 

        return `
            <div class="checkbox-option" style="justify-content: space-between; margin-bottom: 5px; border-radius: 30px; display: flex; align-items: center; padding: 5px 15px; background: rgba(255,255,255,0.05);">
                <span style="font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px;">
                    ${item.userData.fileName || 'Accessory ' + (index + 1)}
                </span>
                <div style="display: flex; gap: 10px; align-items: center;">
                    <span onclick="toggleSingleUgc(${index})" style="cursor: pointer; font-size: 14px;" title="Toggle Visibility">
                        ${eyeIcon}
                    </span>
                    <span onclick="removeUgc(${index})" style="color: #ef4444; cursor: pointer; font-weight: bold; font-size: 14px;" title="Remove">
                        ✕
                    </span>
                </div>
            </div>
        `;
    }).join('');
}

window.removeUgc = function(index) {
    const item = equippedUgc[index];
    if (item && polyModel) {
        polyModel.remove(item);
        equippedUgc.splice(index, 1);
        renderUgcList();
    }
};

window.toggleSingleUgc = function(index) {
    const item = equippedUgc[index];
    if (item) {
        item.visible = !item.visible;
        renderUgcList();
        const status = item.visible ? "shown" : "hidden";
        console.log(`${item.userData.fileName} is now ${status}`);
    }
};

async function loadUgc(file) {
    if (equippedUgc.length >= 9) return alert("Max 9 accessories!");
    if (!polyModel) return alert("Load character first!");

    updateStatus(`Loading ${file.name}...`, 'loading');

    const reader = new FileReader();
    
    reader.onload = function(event) {
        const contents = event.target.result;
        const loader = new THREE.GLTFLoader();

        loader.parse(contents, '', (gltf) => {
            const accessory = gltf.scene;
            
            accessory.traverse(child => {
                if (child.isMesh) {
                    child.userData.isUGC = true;
                    child.castShadow = true;
                }
            });

            accessory.userData.fileName = file.name;
            polyModel.add(accessory);
            equippedUgc.push(accessory);

            renderUgcList();
            updateStatus("Accessory added!", "success");
        }, (err) => {
            updateStatus("Failed to parse GLB data", "error");
            console.error(err);
        });
    };

    reader.readAsArrayBuffer(file);
}

function applyCanvasAsTexture(canvas) {
    const texture = new THREE.CanvasTexture(canvas);
    texture.flipY = false;
    texture.encoding = THREE.sRGBEncoding;
    
    polyModel.traverse(child => {
        if (child.isMesh && !child.userData.isUGC) {
            const meshName = child.name.toLowerCase();
            const isTarget = BODY_PARTS.shirt.some(part => meshName.includes(part));
            
            if (isTarget) {
                child.material = createMaterial(currentSkinTone, texture);
            } else {
                const isFace = meshName.includes('head') || meshName.includes('face');
                child.material = createMaterial(currentSkinTone, isFace ? faceTexture : null);
            }
            child.material.needsUpdate = true;
        }
    });
}

async function downloadTexturesZip() {
    if (!polyModel) return alert("Please load a character first!");
    updateStatus("Preparing ZIP Archive...", "loading");

    if (typeof JSZip === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        document.head.appendChild(script);
        await new Promise(resolve => script.onload = resolve);
    }

    const zip = new JSZip();
    const textureFolder = zip.folder("textures");
    let textureCount = 0;

    polyModel.traverse((child) => {
        if (child.isMesh && child.material) {
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            
            materials.forEach((mat, index) => {
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

                        const fileName = `${child.name || 'accessory'}_${textureCount}.png`;
                        textureFolder.file(fileName, base64Data, {base64: true});
                        textureCount++;
                    } catch (e) {
                        console.warn(`Could not extract texture from ${child.name}:`, e);
                    }
                }
            });
        }
    });

    if (textureCount === 0) {
        updateStatus("No textures found to ZIP.", "error");
        return;
    }

    const content = await zip.generateAsync({type: "blob"});
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = "character_textures.zip";
    link.click();
    
    updateStatus(`ZIP Downloaded! (${textureCount} files)`, "success");
}

async function downloadGeometry() {
    if (!polyModel) return alert("Please load a character first!");
    updateStatus("Baking Geometry (No Textures)...", "loading");

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
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = "character_geometry.glb";
            link.click();
            updateStatus("Geometry Downloaded!", "success");
        },
        (err) => {
            console.error("Geometry Export Failed:", err);
            updateStatus("Geometry Export Failed", "error");
        },
        { binary: true }
    );
}

const bgInput = document.getElementById('bgColor');
if (bgInput) {
    bgInput.addEventListener('input', e => renderer.setClearColor(e.target.value));
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
    uploadInput.addEventListener('change', function(e) {
        if (!polyModel) {
            alert('Please load a character model first!');
            return;
        }
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (event) => {
            const textureLoader = new THREE.TextureLoader();
            textureLoader.load(event.target.result, (texture) => {
                texture.flipY = false;
                texture.encoding = THREE.sRGBEncoding;
                
                const clothingType = document.getElementById('clothingType').value;
                const keepExisting = document.getElementById('keepTextures')?.checked ?? true;

                activeTextures[clothingType] = texture;
                if (clothingType === 'face') faceTexture = texture;
                
                refreshModelTextures(keepExisting, clothingType);
            });
        };
        reader.readAsDataURL(file);
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
    });
}

const ugcUpload = document.getElementById('ugcUpload');
if (ugcUpload) {
    ugcUpload.addEventListener('change', function(e) {
        if (!polyModel) {
            alert('Please load a character model first!');
            this.value = '';
            return;
        }

        const file = e.target.files[0];
        if (!file) return;

        if (equippedUgc.length >= 9) {
            alert('Maximum 9 accessories reached!');
            this.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = function(event) {
            const contents = event.target.result;
            const loader = new THREE.GLTFLoader();

            loader.parse(contents, '', (gltf) => {
                const accessory = gltf.scene;
                accessory.userData.fileName = file.name;
                
                accessory.traverse(child => {
                    if (child.isMesh) {
                        child.userData.isUGC = true; 
                    }
                });
            
                polyModel.add(accessory);
                equippedUgc.push(accessory);
                renderUgcList();
            });
        };
        
        reader.readAsArrayBuffer(file);
        this.value = ''; 
    });
}

const clearUgcBtn = document.getElementById('clearUgcBtn');
if (clearUgcBtn) {
    clearUgcBtn.addEventListener('click', () => {
        equippedUgc.forEach(item => polyModel.remove(item));
        equippedUgc = [];
        renderUgcList();
        updateStatus("All UGC cleared", "info");
    });
}

const convertBtn = document.getElementById('convertBtn');
if (convertBtn) {
    convertBtn.addEventListener('click', async () => {
        const fileInput = document.getElementById('converterInput');
        const file = fileInput?.files[0];
        if (!file) { 
            alert('Please select a template image first!'); 
            return; 
        }
        
        const mode = document.querySelector('input[name="convertMode"]:checked')?.value || 'rbx2poly';
        const isRbx2Poly = mode === 'rbx2poly';
        const srcMap = isRbx2Poly ? rbxMapData : polyMapData;
        const destMap = isRbx2Poly ? polyMapData : rbxMapData;
        
        updateStatus('Converting...', 'loading');
        
        try {
            const img = new Image();
            const reader = new FileReader();
            
            await new Promise((resolve, reject) => {
                reader.onload = (e) => {
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = e.target.result;
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
            
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
            
            canvas.toBlob((blob) => {
                if (!blob) {
                    updateStatus('Conversion failed', 'error');
                    return;
                }
                
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.download = isRbx2Poly ? 'polytoria_template.png' : 'roblox_template.png';
                link.href = url;
                
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                
                setTimeout(() => URL.revokeObjectURL(url), 100);
                
                updateStatus('Conversion complete!', 'success');
                
                if (document.getElementById('clothingType')?.value === 'shirt' && polyModel) {
                    applyCanvasAsTexture(canvas);
                }
            }, 'image/png', 1.0);
        } catch (err) { 
            console.error('Conversion error:', err);
            updateStatus('Conversion failed - try a different image', 'error');
        }
    });
}

const addUgcBtn = document.getElementById('addUgcBtn');
if (addUgcBtn) {
    addUgcBtn.addEventListener('click', () => {
        const idInput = document.getElementById('ugcId');
        const id = idInput.value.trim();
        if (id) {
            loadUgc(id);
            idInput.value = '';
        }
    });
}

window.addEventListener('load', () => {
    const bg = document.getElementById('bgColor');
    if (bg) renderer.setClearColor(bg.value);
    
    loadModelFromPath('character.glb');
    setTimeout(() => loadFaceDecal('Smile.png'), 1000);
    
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
        
        mobileToggle.addEventListener('click', (e) => {
            if (window.innerWidth > 768) {
                controlsPanel.classList.toggle('open');
            }
        });
    }
    
    setupDropZone('converterDropZone', 'converterInput', ['image/png', 'image/jpeg', 'image/jpg']);
    setupDropZone('ugcDropZone', 'ugcUpload', ['model/gltf-binary', '.glb']);
    
    const genderRadios = document.querySelectorAll('input[name="characterGender"]');
    genderRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            const modelPath = e.target.value === 'female' ? 'character_female.glb' : 'character.glb';
            loadModelFromPath(modelPath);
        });
    });
});

function setupDropZone(dropZoneId, inputId, acceptedTypes) {
    const dropZone = document.getElementById(dropZoneId);
    const input = document.getElementById(inputId);
    
    if (!dropZone || !input) return;
    
    const textElement = dropZone.querySelector('.drop-zone-text');
    const originalText = textElement.textContent;
    
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
                
                updateDropZoneText(dropZone, textElement, file.name);
                
                const event = new Event('change', { bubbles: true });
                input.dispatchEvent(event);
            } else {
                alert('Invalid file type. Please upload the correct format.');
            }
        }
    });
    
    dropZone.addEventListener('click', (e) => {
        if (e.target !== input) {
            input.click();
        }
    });
    
    input.addEventListener('change', (e) => {
        if (input.files.length > 0) {
            updateDropZoneText(dropZone, textElement, input.files[0].name);
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
