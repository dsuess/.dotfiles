#!/bin/sh
############################
# make.sh
# This script creates symlinks from the home directory to any desired dotfiles in ~/dotfiles
############################

########## Variables

dir=~/.dotfiles                    # dotfiles directory
olddir=~/.dotfiles/old             # old dotfiles backup directory
files="zshrc virc vimrc vim tmux.conf oh-my-zsh gitconfig gitignore git_template bashrc bashrc.local direnvrc"

##########

# create dotfiles_old in homedir
echo "Creating $olddir for backup of any existing dotfiles in ~"
mkdir -p $olddir
echo "...done"

# change to the dotfiles directory
echo "Changing to the $dir directory"
cd $dir
echo "...done"

# move any existing dotfiles in homedir to dotfiles_old directory, then create symlinks
for file in $files; do
    if [ -f ~/.$file ]; then
        echo "Moving existing file .$file from ~ to $olddir"
        mv ~/.$file $olddir
    elif [ -d ~/.$file ]; then
        echo "Moving existing dir .$file from ~ to $olddir"
        mv ~/.$file $olddir
    else
        echo "$file does not exists"
    fi

    echo "Creating symlink to $file in home directory."
    ln -s $dir/$file ~/.$file
done

# More stuff
ln -s ~/.dotfiles/matplotlibrc ~/.config/matplotlib/matplotlibrc
ln -s ~/.dotfiles/bin ~/bin

~/.dotfiles/fzf/install

# set global git template dir
git config --global init.templatedir ~/.git_template
