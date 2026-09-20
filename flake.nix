{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };
  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (
        system: pkgs: {
          default = pkgs.callPackage ./default.nix {
            version = toString (self.lastModified or 0);
          };
          icon = pkgs.runCommand "satin.svg" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
            node ${./logo/render.mjs} > "$out"
          '';
        }
      );
      formatter = forAllSystems (system: pkgs: pkgs.nixfmt-tree);
      checks = forAllSystems (
        system: pkgs: {
          format = self.formatter.${system}.check self;
        }
      );
    };
}
