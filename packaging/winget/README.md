Winget packaging notes

These manifests are templates for submitting hashtree to winget-pkgs.
Update the version and SHA256 after each GitHub Release.

Steps:
1) Create a GitHub Release tag (e.g. v0.2.4) so the Windows zip asset exists.
2) Download the Windows asset and verify its SHA256 (or use the .sha256 file).
3) Update PackageVersion and InstallerSha256 in the manifests.
4) Validate with wingetcreate or winget validate.
5) Submit to winget-pkgs.
