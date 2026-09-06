{
  lib,
  stdenvNoCC,
  fetchurl,
  unzip,
  zip,
  gnupatch,
  # Firefox re-fetches a policy-installed add-on only when the version at
  # `install_url` is newer, so a fixed version would leave every rebuild of this
  # add-on stranded: the store path changes, the browser ignores it. The flake
  # passes its `lastModified`, which advances with each commit. (Seconds since
  # the epoch stays inside the 32-bit part limit Firefox allows until 2038.)
  version,
}:
let
  addonId = "satin@sam.local";
  # Firefox's own extension collection ID; Home Manager's firefox module looks
  # for XPIs under this path and names them by add-on ID.
  extensionPath = "extensions/{ec8030f7-c20a-464f-9b0e-13a3a9e97384}";

  pdfjsVersion = "6.2.108";
  # The prebuilt viewer distribution, so there is no npm/gulp build to package.
  pdfjs = fetchurl {
    url = "https://github.com/mozilla/pdf.js/releases/download/v${pdfjsVersion}/pdfjs-${pdfjsVersion}-dist.zip";
    hash = "sha256-e/ZC1ZWCtHXoxIRH2psCsBCPrZdC18KjXLTtbdRelbo=";
  };
in
stdenvNoCC.mkDerivation {
  pname = "satin";
  inherit version;
  src = ./ext;

  nativeBuildInputs = [
    unzip
    zip
    gnupatch
  ];

  dontConfigure = true;

  # The same script a person without Nix would run, so the README's
  # instructions and this derivation cannot describe different builds.
  buildPhase = ''
    runHook preBuild
    EXT_DIR="$PWD" PDFJS_ZIP=${pdfjs} VERSION=${version} \
      PATCH=${./pdfjs-viewer-html.patch} \
      bash ${./build.sh} "$PWD/satin.xpi"
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm444 satin.xpi \
      "$out/share/mozilla/${extensionPath}/${addonId}.xpi"
    runHook postInstall
  '';

  passthru = { inherit addonId pdfjsVersion; };

  meta = {
    description = "Browser add-on that recolors PDFs live, remapping the document's real palette";
    longDescription = ''
      Neither Firefox nor Chrome runs content scripts in its built-in PDF viewer
      (bugzilla 1454760), so Satin ships its own pdf.js viewer. Colors are
      intercepted where pdf.js assigns them to the canvas, which yields the
      document's exact palette and lets any color be remapped live. Vector
      content only: raster images are out of scope by design.
    '';
    platforms = lib.platforms.all;
    license = lib.licenses.mit;
  };
}
