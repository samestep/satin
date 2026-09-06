{
  description = "Satin: a dark-mode PDF reader browser extension";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      packages = forAllSystems (pkgs: rec {
        # The extension, as an XPI under result/share/mozilla/extensions/. Firefox only replaces a
        # policy-installed add-on with a higher version, so the version is the flake's last-modified
        # time, which advances with every commit (see default.nix).
        satin = pkgs.callPackage ./default.nix {
          version = toString (self.lastModified or 0);
        };
        # The logo: an SVG of lines, elliptical arcs and linear gradients, written by logo/render.mjs, which is
        # self-contained (model and parameters included).
        svg = pkgs.runCommand "satin.svg" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
          node ${./logo/render.mjs} > "$out"
        '';
        # The same logo as a 1024x1024 PNG: a rasterization of the SVG.
        icon = pkgs.runCommand "satin-icon.png" { nativeBuildInputs = [ pkgs.resvg ]; } ''
          resvg -w 1024 -h 1024 ${svg} "$out"
        '';
        default = satin;
      });
    };
}
