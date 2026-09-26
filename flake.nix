{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    # The prebuilt pdf.js viewer. A release asset never moves, so `nix flake update` leaves this alone;
    # to upgrade, change the version here (and in reader.patch, if an anchor line moved).
    pdfjs = {
      url = "https://github.com/mozilla/pdf.js/releases/download/v6.3.289/pdfjs-6.3.289-dist.zip";
      flake = false;
    };
  };
  outputs =
    {
      self,
      nixpkgs,
      pdfjs,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      addonId = "satin@samestep.com";
      # Firefox's own extension collection ID: Home Manager's Firefox module looks for XPIs under
      # this path, named by add-on ID, and needs `addonId` in passthru.
      extensionPath = "share/mozilla/extensions/{ec8030f7-c20a-464f-9b0e-13a3a9e97384}";
    in
    {
      packages = forAllSystems (pkgs: rec {
        # The logo, as an SVG (see icon.mjs).
        icon = pkgs.runCommand "satin.svg" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
          node ${./icon.mjs} > "$out"
        '';
        # The extension as a directory, which Chrome's "Load unpacked" takes: src/, icons rasterized from
        # the logo, the pdf.js distribution byte-for-byte as released (add-on reviewers check bundled
        # libraries against the official release, so nothing in pdfjs/ may change), and reader.html, which
        # is pdf.js's own viewer.html with three lines added (see reader.patch) written outside pdfjs/.
        # --fuzz=0 so that a pdf.js upgrade which moves an anchor fails the build rather than shipping a
        # viewer with Satin silently dropped.
        unpacked = pkgs.runCommand "satin-unpacked" { nativeBuildInputs = [ pkgs.resvg ]; } ''
          cp -r --no-preserve=mode ${./src} "$out"
          cp -r --no-preserve=mode ${pdfjs} "$out/pdfjs"
          patch --fuzz=0 -o "$out/reader.html" "$out/pdfjs/web/viewer.html" ${./reader.patch}
          for s in 16 32 48 96 128; do
            resvg -w "$s" -h "$s" ${icon} "$out/icon-$s.png"
          done
        '';
        # The same as an archive. It is a plain zip: the manifest covers both engines, so the one file
        # loads in Firefox (as an .xpi) and in Chrome, Edge, Brave, Vivaldi and Opera. Sorted entries
        # and no extra fields (-X) keep it byte-identical across builds; zip clamps the store's 1970
        # timestamps to 1980, which is the earliest Firefox accepts.
        xpi = pkgs.runCommand "satin.xpi" { nativeBuildInputs = [ pkgs.zip ]; } ''
          cd ${unpacked}
          find . -type f | LC_ALL=C sort | zip -q -X -D -9 "$TMPDIR/satin.xpi" -@
          install -m444 "$TMPDIR/satin.xpi" "$out"
        '';
        # The archive laid out for Home Manager's Firefox module (`profiles.<name>.extensions.packages`).
        default =
          pkgs.runCommand "satin"
            {
              passthru = { inherit addonId; };
              meta = {
                license = pkgs.lib.licenses.mit;
                platforms = pkgs.lib.platforms.all;
              };
            }
            ''
              install -Dm444 ${xpi} "$out/${extensionPath}/${addonId}.xpi"
            '';
      });
      checks = forAllSystems (
        pkgs:
        let
          inherit (self.packages.${pkgs.stdenv.hostPlatform.system}) default icon;
        in
        {
          build = default;
          # The checked-in logo must be what icon.mjs produces.
          icon = pkgs.runCommand "satin-icon-check" { } ''
            diff ${./icon.svg} ${icon}
            touch "$out"
          '';
          # treefmt's own check: copies the tree, runs the formatter, fails on any diff.
          formatting = self.formatter.${pkgs.stdenv.hostPlatform.system}.check self;
        }
      );
      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
