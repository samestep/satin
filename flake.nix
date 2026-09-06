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
        # The logo as a 1024x1024 PNG. logo/render.mjs is self-contained: model and parameters included.
        icon = pkgs.runCommand "satin-icon.png" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
          node ${./logo/render.mjs} 1024 > "$out"
        '';
        default = satin;
      });
    };
}
