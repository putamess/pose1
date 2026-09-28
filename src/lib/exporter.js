// PNG export. The canvas is created with preserveDrawingBuffer:true, and we
// render explicitly right before reading pixels so the capture always matches
// the current view mode (line-art materials / silhouette override are part of
// the normal render state).

export function capturePNG({ gl, scene, camera }, { scale = 1, filename } = {}) {
  const canvas = gl.domElement;
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;

  if (scale !== 1) {
    gl.setSize(Math.round(cssW * scale), Math.round(cssH * scale), false);
  }
  gl.render(scene, camera);
  const url = canvas.toDataURL('image/png');

  if (scale !== 1) {
    gl.setSize(cssW, cssH, false);
    gl.render(scene, camera);
  }

  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `pose_${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return url;
}
