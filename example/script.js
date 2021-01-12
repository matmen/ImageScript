(async () => {
  const avatar = await fetch("https://raw.githubusercontent.com/matmen/ImageScript/master/tests/targets/readme.png").then((r) => r.arrayBuffer());
  const image = await ImageScript.Image.decode(avatar);

  image.saturation(0);

  const encoded = await image.encode();

  // need to pass data to main thread as blob URI, cannot access document directly
  const blob = new Blob([encoded], { type: "image/png" });
  document.querySelector("#image").src = URL.createObjectURL(blob);
})();
