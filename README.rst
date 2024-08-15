Loupedeck Control
-----------------

- Setup: ``npm install``
- Run: ``./ctrl.mjs``

Profile is currently in ``profile.yaml``.

Permission issue: copy ``50-loupedeck.rules`` to be under ``/etc/udev/rules.d`` and then ``sudo udevadm control --reload-rules && sudo udevadm trigger``.
